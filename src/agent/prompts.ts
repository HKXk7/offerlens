/**
 * Prompt 版本 —— 评测的"实验变量"。
 *
 * 设计原则：**两版之间只改一条约束**。
 * 如果 p2 同时"加了锚点要求 + 换了输出格式 + 改了口吻"，
 * 那跑出来变好了也不知道是哪一条起了作用。评测的可解释性全靠这个。
 *
 *   p1-baseline ：只说"给出改进建议"，不约束锚点、不禁止编造 —— 代表通常做法
 *   p2-strict   ：强制每条建议绑定段 ID；给不出出处的必须显式留空；
 *                 禁止引入简历里没有的数字与实体
 *
 * 三处 `<SEG>` 标记是给"考卷"用的：评测时把简历分段文本塞进去，
 * 段 ID 是锚点的唯一标识（见 src/schema/case.ts 的注释）。
 */

import type { Jd, Resume } from '../schema/case.js';

export const PROMPT_VERSIONS = ['p1-baseline', 'p2-strict'] as const;

/** 把简历渲染成带段 ID 的文本。段 ID 必须原样出现，否则模型没法回填锚点 */
export function renderResume(resume: Resume): string {
  const lines: string[] = [`【求职意向】${resume.headline}`, ''];
  lines.push('【分段正文】');
  for (const seg of resume.segments) {
    lines.push(`[${seg.seg_id}] ${seg.text}`);
  }
  if (resume.skills.length > 0) lines.push('', `【技能】${resume.skills.join('、')}`);
  return lines.join('\n');
}

export function renderJd(jd: Jd): string {
  return [`【岗位】${jd.title}（${jd.company_type}）`, '', jd.raw].join('\n');
}

/* ------------------------------------------------------------------ */
/* Step 1：解析 JD 的硬性要求                                          */
/* ------------------------------------------------------------------ */

export interface JdAnalysis {
  hard_req: string[];
  soft_req: string[];
}

export function jdAnalysisMessages(jd: Jd): Array<{ role: 'system' | 'user'; content: string }> {
  return [
    {
      role: 'system',
      content: [
        '你是一个招聘信息解析器。从 JD 原文里抽出两类要求。',
        '',
        '硬性要求（hard_req）：不满足就基本没机会的，如学历、专业、年限、必会技术栈。',
        '软性要求（soft_req）：加分项、业务方向、团队偏好。',
        '',
        '要求：',
        '1. 每条不超过 12 个字，用原文的措辞，不要自己改写或归纳。',
        '2. 只抽 JD 里明确写了的，不要脑补常见的行业要求。',
        '3. 硬性要求最多 6 条，挑最关键的。',
        '',
        '只输出 JSON，格式：{"hard_req": ["..."], "soft_req": ["..."]}',
      ].join('\n'),
    },
    { role: 'user', content: renderJd(jd) },
  ];
}

/* ------------------------------------------------------------------ */
/* Step 2：在简历里逐条找证据                                          */
/* ------------------------------------------------------------------ */

export interface GateEvidence {
  /** 要求原文 */
  gate: string;
  /** 判定：hit = 有明确证据 / partial = 沾边但不充分 / missing = 找不到 */
  verdict: 'hit' | 'partial' | 'missing';
  /** 支撑该判定的简历段 ID。missing 时必须为空数组 */
  evidence_seg_ids: string[];
  /** 一句话说明凭据 */
  reason: string;
}

export interface ResumeAnalysis {
  gates: GateEvidence[];
}

export function resumeAnalysisMessages(
  resume: Resume,
  analysis: JdAnalysis,
  strict: boolean,
): Array<{ role: 'system' | 'user'; content: string }> {
  const rules = [
    '你是一个简历事实核对员。逐条检查简历是否满足下面的要求，**只依据简历原文判断，不许推断**。',
    '',
    '判定标准：',
    '- hit：简历里有明确的段落支撑这条要求',
    '- partial：沾边，但程度不够或没有说明关键细节',
    '- missing：简历里找不到任何相关内容',
    '',
    '硬规定：',
    '1. evidence_seg_ids 只能填方括号里出现的段 ID（如 S01），且必须是**真的**支撑这条判定的段落。',
    '2. verdict 是 missing 时，evidence_seg_ids 必须是空数组 []。宁可判缺失，也不要硬找一段凑上。',
    '3. 不要因为"这个岗位一般需要"就判 hit，只看简历写了什么。',
  ];
  if (strict) {
    rules.push(
      '4. 特别注意：简历里用了别的技术栈、别的方法，**不等于**满足本条要求。例如要求 React 而简历只有 Vue，应判 missing。',
    );
  }

  return [
    { role: 'system', content: rules.join('\n') },
    {
      role: 'user',
      content: [
        '待核对的要求：',
        ...analysis.hard_req.map((g, i) => `${i + 1}. ${g}`),
        '',
        '简历：',
        renderResume(resume),
        '',
        '只输出 JSON，格式：{"gates": [{"gate": "要求原文", "verdict": "hit|partial|missing", "evidence_seg_ids": ["S01"], "reason": "一句话凭据"}]}',
        '要求数量必须与上面一致，顺序也要一致。',
      ].join('\n'),
    },
  ];
}

/* ------------------------------------------------------------------ */
/* Step 3：生成建议                                                    */
/* ------------------------------------------------------------------ */

export function generateMessages(
  resume: Resume,
  jd: Jd,
  gates: readonly GateEvidence[],
  strict: boolean,
): Array<{ role: 'system' | 'user'; content: string }> {
  const common = [
    '你是一个求职简历顾问。基于核对结果，给出具体的改进建议。',
    '',
    '关于"可执行"的定义（这是评分标准，请照做）：',
    '  3 分 = 明确指出改哪一段、改成什么，看完就能动手',
    '  2 分 = 方向对，但没给出具体改法',
    '  1 分 = 套话，如"突出你的优势"，看完不知道该改哪一行',
    '尽量写 3 分的建议。',
  ];

  const rules = strict
    ? [
        '',
        '硬规定（必须全部遵守）：',
        '1. **每条建议都必须绑定一个简历段 ID**（anchor_seg_id），指向这条建议要改的那一段。',
        '   这一段必须真的与建议相关——不能随便挂一个来凑数。',
        '2. **不许引入简历里没有的事实**。特别是数字：不许出现简历原文里找不到的百分比、人数、时长、日活等。',
        '   想写"提升了 XX%"时，如果简历里没这个数，就写"这里缺少量化，建议补上你实际的提升幅度"，而不是编一个。',
        '3. 技能缺失类建议：把它挂到最接近的技能段或项目段上，并在文字里说明是哪一段缺少什么。',
        '4. 每条建议只讲一件事，不要合并。',
      ]
    : [
        '',
        '输出 3–5 条改进建议即可，按重要性排序。',
      ];

  return [
    { role: 'system', content: [...common, ...rules].join('\n') },
    {
      role: 'user',
      content: [
        '岗位：',
        renderJd(jd),
        '',
        '简历：',
        renderResume(resume),
        '',
        '要求核对结果：',
        ...gates.map(
          (g, i) =>
            `${i + 1}. ${g.gate} —— ${g.verdict}` +
            (g.evidence_seg_ids.length > 0 ? `（证据段：${g.evidence_seg_ids.join('、')}）` : '') +
            `｜${g.reason}`,
        ),
        '',
        '只输出 JSON，格式：',
        '{"suggestions": [{"kind": "improve|missing|hit", "text": "建议正文", "anchor_seg_id": "S01 或 null"}]}',
        'kind 的含义：improve = 改现有内容；missing = 缺这项要补；hit = 已满足但可以写得更好。',
      ].join('\n'),
    },
  ];
}

/* ------------------------------------------------------------------ */
/* 裁判：可执行性打分                                                  */
/* ------------------------------------------------------------------ */

export interface JudgeVerdict {
  scores: Array<{ index: number; score: 1 | 2 | 3; reason: string }>;
}

/**
 * 打分 prompt 的三条防偏见措施（见 src/metrics/judge.ts 的注释）：
 *   · 显式禁止因为"更长"给高分 —— 治长度偏见
 *   · 要求先给理由再给分 —— 减少拍脑袋
 *   · 模糊场景调用方会正反序各跑一次 —— 治位置偏见
 */
export function judgeMessages(
  suggestions: readonly string[],
  ordered: boolean,
): Array<{ role: 'system' | 'user'; content: string }> {
  return [
    {
      role: 'system',
      content: [
        '你是一个严格但公正的简历建议评审。给每条建议的**可执行性**打分。',
        '',
        '评分标准：',
        '  3 = 明确指出改哪一段、改成什么，读者看完可以直接动手改',
        '  2 = 方向是对的，但没有给出具体改法，读者还要自己想',
        '  1 = 套话，如"突出你的优势""加强项目描述"，读者看完不知道该改哪一行',
        '',
        '纪律：',
        '1. **不要因为建议更长就给更高分**。长而空泛的必须低于短而具体。',
        '2. 不要因为措辞礼貌、格式整齐而加分。只看"能不能照着做"。',
        '3. 先写 reason（不超过 30 字），再给 score。',
        '4. 逐条独立评分，不要为了拉开档次而故意给不同的分。',
        ordered ? '' : '',
        '只输出 JSON，格式：{"scores": [{"index": 0, "score": 1|2|3, "reason": "..."}]}',
        'index 从 0 开始，必须与输入的条数一致。',
      ]
        .filter((l) => l !== '')
        .join('\n'),
    },
    {
      role: 'user',
      content: suggestions.map((s, i) => `${i}. ${s}`).join('\n\n'),
    },
  ];
}
