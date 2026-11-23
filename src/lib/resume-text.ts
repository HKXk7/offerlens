/**
 * 把「一份真实的纯文本简历」切成带稳定段 ID 的 segments。
 *
 * 为什么需要这一层：评测集里的简历是人工拆好的 JSON（S01、S02…每个段一条证据），
 * 而真实用户手上只有一份 Markdown / Word 导出的 txt。没有分段就没有锚点，
 * 于是"这条建议是改简历的哪一句"就无从谈起 —— 整个项目最有价值的那条指标直接失效。
 *
 * 三条硬要求：
 *   1. **确定性**：同一份文本切两次必须完全一样（段 ID 顺序稳定），否则同一个人
 *      跑两次诊断，锚点对不上，报告不可比。
 *   2. **自描述**：段文本要带上所属小节（`教育背景：…`），
 *      因为锚点在报告里是单独摘出来给人看的，光看"XX 大学 · 本科"不知道是哪个栏目。
 *   3. **不吞内容**：超过上限的段要按句读切开而不是截断，宁可多几段，不能丢信息。
 *
 * 已知局限（必须承认，别装作能切开一切）：
 *   · 双栏排版的 PDF 导出成纯文本后顺序会乱，这里救不回来 —— 需要人工按"一段一行"整理
 *   · 表格里的内容（有些简历用表格排版）会被摊平成一行行文本，语义可能错位
 *   · 小节标题靠关键词识别（见 SECTION_HINT），冷门栏目名会被当普通正文
 */

import type { ResumeSegment } from '../schema/case.js';

export interface SegmentOptions {
  /** 单段字符上限，超过就在句读处再切。默认 260 —— 与人工拆的评测集粒度接近（60~160 字） */
  maxChars?: number;
  /** 段数上限。默认 40，超出部分合并，避免一次诊断把 prompt 撑爆 */
  maxSegments?: number;
}

export interface SegmentedResume {
  segments: ResumeSegment[];
  /** 从「求职意向 / 意向岗位」小节里读到的求职意向；没读到就是空串 */
  headline: string;
  /** 从「技能 / 技术栈」小节里切出来的技能词 */
  skills: string[];
  /**
   * 切分过程中值得告诉用户的事（超长段被拆、段数超限被合并、小节没识别出来……）。
   * 这些不影响可运行性，但会影响"锚点准不准"，所以要显式打印出来。
   */
  warnings: string[];
}

const BULLET_RE = /^\s*(?:[-*+•·▪]|\d{1,2}[.)、])\s+/;
const HEADING_RE = /^\s*#{1,6}\s+(.+?)\s*#*\s*$/;
/** 小节标题的关键词表：命中才算小节，否则当正文（人名、"简历"这类标题会被丢掉） */
const SECTION_HINT =
  /(教育|学习经历|技能|技术栈|专长|实习|工作经历|项目|经历|竞赛|荣誉|获奖|证书|自我评价|个人评价|求职意向|意向岗位|联系方式|开源|作品|论文|科研|校园|社团|语言能力)/;
const INTENT_HINT = /(求职意向|意向岗位|求职方向|目标岗位)/;
const SKILL_HINT = /(技能|技术栈|专长|专业技能)/;

function normalize(text: string): string[] {
  return text
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .filter((line, i, all) => {
      // 连续空行压成一个：空行是"分块"信号，重复的空行没有额外信息，
      // 却会让下面的状态机多走几轮（也会让输出随排版细节漂移）。
      if (line.trim().length > 0) return true;
      return i > 0 && all[i - 1].trim().length > 0;
    });
}

/** 按句读切成不超过 maxChars 的块；单句本身超长时硬切（不丢字） */
export function splitLongParagraph(text: string, maxChars = 260): string[] {
  if (text.length <= maxChars) return [text];
  const sentences = text.split(/(?<=[。；;！!？?])/).filter((s) => s.trim().length > 0);
  const out: string[] = [];
  let buf = '';
  for (const s of sentences) {
    if (buf.length + s.length <= maxChars) {
      buf += s;
      continue;
    }
    if (buf.length > 0) out.push(buf.trim());
    if (s.length <= maxChars) {
      buf = s;
    } else {
      // 单句超长（常见于把一整段项目描述写成逗号连缀）——只能硬切，但要留完整句子感
      let rest = s;
      while (rest.length > maxChars) {
        out.push(rest.slice(0, maxChars).trim());
        rest = rest.slice(maxChars);
      }
      buf = rest;
    }
  }
  if (buf.trim().length > 0) out.push(buf.trim());
  return out;
}

const NON_TERM_RE = /(能写|做过|写过|编写|实现|参与|完成|搭建|负责)/;

/** 技能词清洗：去掉列表符号、首尾标点，过滤掉"熟悉/熟练使用"这类动词前缀 */
function cleanSkill(raw: string): string | null {
  let s = raw
    .replace(BULLET_RE, '')
    .replace(/^[\s:：、,，;；/|]+/, '')
    .replace(/[\s:：、,，;；/|]+$/, '')
    .trim();
  s = s.replace(/^(?:熟悉|熟练|掌握|了解|使用过|会用|精通|能独立完成)\s*/, '').trim();
  // "Playwright 编写端到端测试" 里的技术名在动词前面，先截断再判断，
  // 直接整条丢掉会漏掉真技能（这一条就是实测漏掉 Playwright 后补的）。
  if (NON_TERM_RE.test(s)) {
    s = s.split(NON_TERM_RE)[0].trim();
  }
  if (s.length < 2 || s.length > 14) return null;
  if (!/[\u4e00-\u9fa5A-Za-z0-9]/.test(s)) return null;
  return s;
}

export function segmentResume(text: string, opts: SegmentOptions = {}): SegmentedResume {
  const maxChars = opts.maxChars ?? 260;
  const maxSegments = opts.maxSegments ?? 40;
  const lines = normalize(text ?? '');

  if (lines.every((l) => l.trim().length === 0)) {
    throw new Error('简历内容为空：请检查 --resume 指向的文件，或确认正文没有被加密 / 图片化');
  }

  const warnings: string[] = [];
  const pending: string[] = []; // 已确定分段、等待编号的文本
  const skillSource: string[] = [];
  let headline = '';
  let section: string | null = null;
  let paragraph: string[] = [];
  let splitCount = 0; // 有多少段因为超长被切成多块（用于如实告知用户）

  const pushText = (rawText: string): void => {
    const body = rawText.trim();
    if (body.length === 0) return;
    const pieces = splitLongParagraph(body, maxChars);
    if (pieces.length > 1) splitCount++;
    for (const piece of pieces) {
      // 同一个栏目内重复的句子只留第一条（复制粘贴排版时很常见）
      if (pending.length > 0 && pending[pending.length - 1] === piece) continue;
      pending.push(piece);
    }
  };

  const flushParagraph = (): void => {
    if (paragraph.length === 0) return;
    const joined = paragraph.join(' ');
    paragraph = [];
    // 正文段落带上小节名，让锚点单独摘出来时也能读懂
    pushText(section ? `${stripSectionTail(section)}：${joined}` : joined);
  };

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed.length === 0) {
      flushParagraph();
      continue;
    }

    const heading = HEADING_RE.exec(trimmed);
    if (heading) {
      flushParagraph();
      const title = heading[1].trim();
      // 只认"像小节名"的标题；"张三"这种名字标题丢掉，否则会被拼进正文污染锚点
      section = SECTION_HINT.test(title) ? title : null;
      continue;
    }

    // 纯文本简历常用"教育背景："这种行做小节标题（没有 # 号）
    const inlineSection = /^([\u4e00-\u9fa5A-Za-z ]{2,12})[：:]\s*$/.exec(trimmed);
    if (inlineSection && SECTION_HINT.test(inlineSection[1])) {
      flushParagraph();
      section = inlineSection[1].trim();
      continue;
    }

    if (BULLET_RE.test(trimmed)) {
      flushParagraph();
      const body = trimmed.replace(BULLET_RE, '').trim();
      // 求职意向单独抽出来放进 resume.headline（renderResume 会印在【求职意向】里），
      // 不再单独成段：给它一个锚点没有意义，"改简历"改不到求职意向这一行。
      if (section && INTENT_HINT.test(section)) {
        if (headline.length === 0) headline = body;
        continue;
      }
      if (section && SKILL_HINT.test(section)) skillSource.push(body);
      pushText(section ? `${stripSectionTail(section)}：${body}` : body);
      continue;
    }

    // 「求职意向：AI 平台前端」这种行内小标题 + 内容
    const inlineKv = /^([\u4e00-\u9fa5A-Za-z ]{2,12})[：:]\s*(.+)$/.exec(trimmed);
    if (inlineKv && SECTION_HINT.test(inlineKv[1])) {
      flushParagraph();
      const key = inlineKv[1].trim();
      const value = inlineKv[2].trim();
      if (INTENT_HINT.test(key)) {
        if (headline.length === 0) headline = value;
        continue;
      }
      if (SKILL_HINT.test(key)) skillSource.push(value);
      // 单行小标题不再单独成段，直接作为本段正文（否则每行都会多出一个"标题段"）
      pushText(`${stripSectionTail(key)}：${value}`);
      continue;
    }

    paragraph.push(trimmed);
  }
  flushParagraph();

  /* ---------- 编号 ---------- */
  let bodies = pending;
  if (bodies.length === 0) {
    throw new Error('未能从简历里切出任何内容段：请确认正文不是图片 / 也未被加密');
  }
  if (bodies.length > maxSegments) {
    const head = bodies.slice(0, maxSegments - 1);
    const tail = bodies.slice(maxSegments - 1).join('；');
    bodies = [...head, tail];
    warnings.push(
      `切出 ${pending.length} 段，超过上限 ${maxSegments}：尾部已合并为 1 段（锚点会变粗，必要时用 --max-segments 调大）`,
    );
  }
  if (splitCount > 0) {
    warnings.push(
      `有 ${splitCount} 段超过 ${maxChars} 字，已按句读切开：锚点会变细，这是刻意的取舍`,
    );
  }

  const width = bodies.length >= 100 ? 3 : 2;
  const segments: ResumeSegment[] = bodies.map((body, i) => ({
    seg_id: `S${String(i + 1).padStart(width, '0')}`,
    text: body,
  }));

  const skills = [
    ...new Set(
      skillSource
        .flatMap((s) => s.split(/[、，,；;/|]+|与|和|及/))
        .map(cleanSkill)
        .filter((s): s is string => s !== null),
    ),
  ].slice(0, 30);

  return { segments, headline: headline.trim(), skills, warnings };
}

/** 去掉小节名末尾的冒号/空格，避免拼出「教育背景：：…」 */
function stripSectionTail(s: string): string {
  return s.replace(/[：:\s]+$/, '').trim();
}
