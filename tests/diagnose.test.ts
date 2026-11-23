/**
 * `npm run diagnose` 的回归测试。
 *
 * 这条链路和批量评测最大的不同：**输入不可控**。评测集的简历是人手拆好的 JSON，
 * 而这里拿到的是一份用户自己的 Markdown。所以真正会出事的地方在"切分"和"参数"上：
 *
 *   · 段 ID 不稳定 → 同一个人的两次诊断锚点对不上，报告不可比
 *   · 空输入不报错 → 模型收到空简历，开始凭空编建议（最坏的一种"成功"）
 *   · `--runs 0` 被当成合法 → 一次都没跑、退出码 0，看起来跑完了
 *   · 门槛/建议里的 `|` 不转义 → Markdown 表格错列，报告直接没法看
 */

import { describe, expect, it } from 'vitest';

import { parseDiagnoseArgs, ArgsError } from '../src/diagnose/args.js';
import { gateTally, renderMarkdown, renderTerminal, type DiagnoseReport } from '../src/diagnose/report.js';
import { segmentResume, splitLongParagraph } from '../src/lib/resume-text.js';

const RESUME = `# 张小明

求职意向：AI 平台前端（实习 / 校招）

## 教育背景

- XX 大学 · 计算机科学与技术 · 本科 · 2022.09 - 2026.06

## 专业技能

- 熟悉 TypeScript 与 React
- 使用过 Playwright 编写端到端测试

## 项目经历

- 可视化埋点平台：独立完成前端全流程。
`;

describe('segmentResume —— 切分与稳定性', () => {
  it('同一份文本切两次结果完全一致（段 ID 稳定）', () => {
    const a = segmentResume(RESUME);
    const b = segmentResume(RESUME);
    expect(a.segments).toEqual(b.segments);
  });

  it('段 ID 从 S01 连续编号，且不跳号', () => {
    const { segments } = segmentResume(RESUME);
    expect(segments.length).toBeGreaterThan(0);
    expect(segments.map((s) => s.seg_id)).toEqual(segments.map((_, i) => `S${String(i + 1).padStart(2, '0')}`));
  });

  it('丢掉人名标题，但保留小节名并拼进段文本（锚点要能单独读懂）', () => {
    const { segments } = segmentResume(RESUME);
    expect(segments.some((s) => s.text.includes('张小明'))).toBe(false);
    const edu = segments.find((s) => s.text.includes('XX 大学'));
    expect(edu?.text.startsWith('教育背景：')).toBe(true);
  });

  it('求职意向只进 headline，不单独成段（给它锚点没有意义）', () => {
    const r = segmentResume(RESUME);
    expect(r.headline).toBe('AI 平台前端（实习 / 校招）');
    expect(r.segments.some((s) => s.text.startsWith('求职意向'))).toBe(false);
  });

  it('技能词按连接词拆开，并剔除"做过/能写"这类句子片段', () => {
    const { skills } = segmentResume(RESUME);
    expect(skills).toContain('TypeScript');
    expect(skills).toContain('React');
    // 动词后面的技术名要留下来：整条丢掉会漏掉真技能
    expect(skills).toContain('Playwright');
    expect(skills.some((s) => s.includes('编写'))).toBe(false);
  });

  it('空内容直接报错，不允许"空简历跑成功"', () => {
    expect(() => segmentResume('   \n\n  \n')).toThrow(/简历内容为空/);
  });

  it('段数超上限时合并尾部，并且如实给出 warning', () => {
    const many = Array.from({ length: 12 }, (_, i) => `- 第 ${i + 1} 行内容`).join('\n');
    const r = segmentResume(`## 项目经历\n\n${many}`, { maxSegments: 5 });
    expect(r.segments).toHaveLength(5);
    expect(r.warnings.join()).toMatch(/超过上限 5/);
  });
});

describe('splitLongParagraph —— 超长段只切不丢', () => {
  it('短段原样返回', () => {
    expect(splitLongParagraph('一句很短的话。', 100)).toEqual(['一句很短的话。']);
  });

  it('按句读切开后拼回去，字数不减少', () => {
    const text = '第一句话内容。第二句话内容。第三句话内容。';
    const parts = splitLongParagraph(text, 8);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.join('').length).toBe(text.length);
  });

  it('单句本身超长时硬切，仍然不丢字', () => {
    const text = '这是一个没有任何句号的超长句子用来测试硬切逻辑是否会丢掉字符啊啊啊啊';
    const parts = splitLongParagraph(text, 10);
    expect(parts.every((p) => p.length <= 10)).toBe(true);
    expect(parts.join('')).toBe(text);
  });
});

describe('parseDiagnoseArgs —— 参数校验', () => {
  it('缺少 --resume 直接报错', () => {
    expect(() => parseDiagnoseArgs(['--jd', 'a.txt'])).toThrow(ArgsError);
  });

  it('--runs 0 被拦下（0 次 = 什么都没干却退出码 0）', () => {
    expect(() => parseDiagnoseArgs(['--resume', 'a.md', '--jd', 'b.txt', '--runs', '0'])).toThrow(/1~10/);
  });

  it('枚举拼错时报错，并列出合法值', () => {
    expect(() => parseDiagnoseArgs(['--resume', 'a.md', '--jd', 'b.txt', '--category', '前端'])).toThrow(
      /app|platform|data|business/,
    );
  });

  it('--help 不需要必填参数', () => {
    expect(parseDiagnoseArgs(['--help']).help).toBe(true);
  });

  it('默认值：runs=1、category=platform、level=junior', () => {
    const a = parseDiagnoseArgs(['--resume', 'a.md', '--jd', 'b.txt']);
    expect(a.runs).toBe(1);
    expect(a.category).toBe('platform');
    expect(a.level).toBe('junior');
    expect(a.dryRun).toBe(false);
  });
});

describe('报告渲染', () => {
  const base: DiagnoseReport = {
    generatedAt: '2026-11-23T00:00:00.000Z',
    resumePath: 'resume.md',
    jdPath: 'jd.txt',
    jdTitle: 'AI 平台前端',
    categoryLabel: 'AI 平台前端',
    levelLabel: '初级',
    experienceLabel: '经历丰富',
    profile: { runId: 'p__p2-strict', modelLabel: '某模型', promptVersion: 'p2-strict' },
    runs: 1,
    segmentCount: 2,
    warnings: [],
    gates: [
      { gate: 'TypeScript', verdict: 'hit', evidence: ['S01'], reason: '技能段明确写了' },
      { gate: '3 年以上经验', verdict: 'missing', evidence: [], reason: '简历只有实习' },
    ],
    suggestions: [
      { kind: 'improve', text: '把「熟悉 React」改成「用 React 做过 X」', anchor: 'S01', anchorText: '技能：TypeScript' },
      { kind: 'missing', text: '补一条 AI 产品的项目经历', anchor: null, anchorText: null },
    ],
    metrics: {
      anchorRate: 0.5,
      anchoredCount: 1,
      totalCount: 2,
      unsourcedRate: 0.25,
      unsourcedTop: [{ entity: 'qps 3000', count: 1 }],
      invalidAnchors: ['S09'],
      strictGateRate: 0.5,
      strictMissing: ['3 年以上经验'],
    },
    cost: { cny: 0.0123, inputTokens: 900, outputTokens: 200, latencyMs: 4200 },
    steps: [{ name: 'analyze_jd', ms: 1100, inputTokens: 500, outputTokens: 60, error: null }],
    error: null,
    artifacts: { runsFile: 'data/live/runs.jsonl', inputsFile: 'data/live/inputs/x.json', reportPath: 'reports/diagnose.md' },
  };

  it('gateTally 统计三种判定', () => {
    expect(gateTally(base.gates)).toEqual({ hit: 1, partial: 0, missing: 1 });
  });

  it('终端报告里能同时看到缺失门槛、无出处建议和假锚点', () => {
    const out = renderTerminal(base);
    expect(out).toContain('3 年以上经验');
    expect(out).toContain('没有指到具体某一段');
    expect(out).toContain('S09');
  });

  it('Markdown 报告转义竖线，避免表格错列', () => {
    const r: DiagnoseReport = {
      ...base,
      gates: [{ gate: 'React | Vue', verdict: 'hit', evidence: ['S01'], reason: 'a|b' }],
    };
    const md = renderMarkdown(r);
    expect(md).toContain('React \\| Vue');
    expect(md).toContain('a\\|b');
  });

  it('失败时报告写清原因，而不是装作"没有建议"', () => {
    const r: DiagnoseReport = { ...base, error: 'analyze_resume 失败：timeout', suggestions: [], gates: [] };
    expect(renderTerminal(r)).toContain('这次诊断没有跑完');
    expect(renderMarkdown(r)).toContain('## 运行失败');
  });
});
