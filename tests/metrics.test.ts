import { describe, expect, it } from 'vitest';
import {
  buildDict,
  buildSourceIndex,
  extractEntities,
  isSourced,
  normalizeNumberLiteral,
  normalizeToken,
} from '../src/metrics/entities.js';
import { detectorCalibration, unsourcedRate, auditSuggestions } from '../src/metrics/unsourced.js';
import { exampleSpans } from '../src/metrics/entities.js';
import { anchorCoverage, hardGateCoverage } from '../src/metrics/anchor.js';
import {
  executability,
  judgeHumanAgreement,
  lengthBiasCorrelation,
  mergeOrderDebiased,
} from '../src/metrics/judge.js';
import { computeStepMetrics, detectLoops } from '../src/metrics/steps.js';
import { passAtKUnbiased, passK, stabilityBreakdown } from '../src/metrics/passk.js';
import { compareRuns, firstRunOnly, partitionFindings, sliceDown, type RunRecord } from '../src/stats/compare.js';
import type { Jd, Resume, Suggestion } from '../src/schema/case.js';
import type { StepSpan } from '../src/schema/trace.js';

const resume: Resume = {
  id: 'r1',
  anon_id: 'R-01',
  headline: '软件工程 · 大三',
  experience_level: 'rich',
  major_related: true,
  segments: [
    {
      seg_id: 'S01',
      text: '熟悉 React 与 TypeScript，把首屏从 1200ms 降到 800ms，抽取了 8 个通用组件',
    },
  ],
  skills: ['React', 'TypeScript'],
  internships: [],
  projects: ['可视化埋点平台'],
};

const jd: Jd = {
  id: 'jd1',
  title: 'AI 应用前端实习生',
  company_type: 'AI 创业公司',
  category: 'app',
  level: 'intern',
  raw: '',
  hard_req: ['React', 'ECharts', 'Node.js'],
  soft_req: ['组件库'],
  source: 'synthetic',
};

describe('实体归一化', () => {
  it('去版本号', () => {
    expect(normalizeToken('React 18')).toBe('react');
    expect(normalizeToken('React')).toBe('react');
    expect(normalizeToken('  TypeScript  ')).toBe('typescript');
  });

  it('ES6 是独立名词，不能被当版本号吃掉', () => {
    expect(normalizeToken('ES6')).toBe('es6');
  });

  it('别名归一', () => {
    expect(normalizeToken('字节')).toBe('字节跳动');
    expect(normalizeToken('JS')).toBe('javascript');
  });

  it('数字带单位归一', () => {
    expect(normalizeNumberLiteral('40%')).toBe('40');
    expect(normalizeNumberLiteral('1.5万')).toBe('15000');
    expect(normalizeNumberLiteral('3k')).toBe('3000');
    expect(normalizeNumberLiteral('800ms')).toBe('800');
  });
});

describe('实体抽取与出处判定', () => {
  const dict = buildDict(resume, jd);
  const index = buildSourceIndex(resume.segments.map((s) => s.text).join('\n'), dict);

  it('抽技术名词与数字，长词优先（Vue 3 不会被拆成 Vue + 3）', () => {
    const ents = extractEntities('熟悉 Vue 3 与 React', dict, { applyExemption: false });
    expect(ents.map((e) => e.raw)).toContain('Vue 3');
    // "Vue 3" 被整体消费掉之后，不应该再冒出一个独立的 number 实体
    expect(ents.filter((e) => e.kind === 'number')).toHaveLength(0);
  });

  it('简历里有的算有出处，没有的算无出处', () => {
    expect(isSourced(
      { raw: 'React', normalized: 'react', kind: 'tech', start: 0, end: 5, exempted: false },
      index,
    )).toBe(true);
    expect(isSourced(
      { raw: '800', normalized: '800', kind: 'number', start: 0, end: 3, exempted: false },
      index,
    )).toBe(true);
    expect(isSourced(
      { raw: '9999', normalized: '9999', kind: 'number', start: 0, end: 4, exempted: false },
      index,
    )).toBe(false);
    expect(isSourced(
      { raw: 'Node.js', normalized: 'node.js', kind: 'tech', start: 0, end: 7, exempted: false },
      index,
    )).toBe(false);
  });

  it('「建议补充」类句式里的新概念要豁免，否则会把合理建议误判成编造', () => {
    const ents = extractEntities('建议补充 Redis 经验', dict);
    expect(ents).toHaveLength(1);
    expect(ents[0].raw).toBe('Redis');
    expect(ents[0].exempted).toBe(true);
    expect(ents[0].exemptReason).toBe('建议补充类句式');
  });

  it('同一句话里没有豁免词时不豁免', () => {
    const ents = extractEntities('Redis 是加分项', dict);
    const redis = ents.find((e) => e.raw === 'Redis');
    expect(redis?.exempted).toBe(true); // "加分项" 命中豁免规则
    const ents2 = extractEntities('我用过 Redis', dict);
    expect(ents2.find((e) => e.raw === 'Redis')?.exempted).toBe(false);
  });

  it('序数引用（第 3 行）不算实体——这是实际踩到的误报', () => {
    const ents = extractEntities('把第 3 行的「参与」改成「负责」', dict, { applyExemption: false });
    expect(ents.filter((e) => e.kind === 'number')).toHaveLength(0);
  });

  it('纯年份不当作成绩数字', () => {
    const ents = extractEntities('2023.09 - 2027.06 就读于 XX 大学', dict, { applyExemption: false });
    expect(ents.filter((e) => e.kind === 'number')).toHaveLength(0);
  });
});

describe('无源实体率', () => {
  const dict = buildDict(resume, jd);
  const sourceText = resume.segments.map((s) => s.text).join('\n');

  const suggestion: Suggestion = {
    id: 'sug-1',
    case_id: 'case-1',
    run_id: 'run-1',
    run_index: 0,
    kind: 'improve',
    text: '把第 3 行的「参与」改成「负责」；用 React 重写列表组件，覆盖率从 60% 提到 85%；建议补充 Redis 经验',
    anchor_seg_id: 'S01',
  };

  it('豁免的不进分母，没出处的进分子', () => {
    const verdicts = auditSuggestions([suggestion], sourceText, dict);
    const r = unsourcedRate(verdicts);
    // React 有出处；60 / 85 没有；Redis 被豁免；「第 3 行」的 3 被排除
    expect(r.considered).toBe(3);
    expect(r.unsourced).toBe(2);
    expect(r.exempted).toBe(1);
    expect(r.rate).toBeCloseTo(2 / 3, 10);
    expect(r.topOffenders.map((o) => o.entity).sort()).toEqual(['60', '85']);
  });
});

describe('示例/模板片段识别（真实数据逼出来的口径修正）', () => {
  const dict = buildDict(resume, jd);
  const sourceText = resume.segments.map((s) => s.text).join('\n');

  const mk = (text: string): Suggestion => ({
    id: 'sug-ex',
    case_id: 'case-1',
    run_id: 'run-1',
    run_index: 0,
    kind: 'improve',
    text,
    anchor_seg_id: 'S01',
  });

  it('exampleSpans：只认成对引号，且需要示例提示词或占位符', () => {
    expect(exampleSpans('例如：「abc」')).toEqual([[3, 8]]);
    // 没有"例如/改成"这类提示词，也没有占位符 —— 不能算示例
    expect(exampleSpans('他说的「React」是简历里的')).toEqual([]);
    // 片段内出现 __ 占位符，即使没有提示词也判定为模板
    expect(exampleSpans('改成「每 __ 秒一次」')).toEqual([[2, 12]]);
  });

  it('示例里的数字被标为示例：严口径计入，扣示例口径不计入', () => {
    const r = unsourcedRate(
      auditSuggestions([mk('建议按示例写，例如：「每 15s 发送心跳 ping，连续 2 次无 pong 判定掉线」。')], sourceText, dict),
    );
    // 15 与 2 都在示例片段内
    expect(r.considered).toBe(2);
    expect(r.exampleLocated).toBe(2);
    expect(r.rate).toBe(1); // 严口径：全是无源
    expect(r.rateExcludingExamples).toBe(0); // 扣示例后：没有可判定的断言
  });

  it('示例与断言混在一起时，两个口径必须能分开', () => {
    const r = unsourcedRate(
      auditSuggestions([mk('例如：「每 15s 发心跳」。另外 React 那行要补 47% 的提升。')], sourceText, dict),
    );
    // 15 在示例内；React 有出处；47 是断言且无源
    expect(r.considered).toBe(3);
    expect(r.unsourced).toBe(2);
    expect(r.exampleLocated).toBe(1);
    expect(r.rate).toBeCloseTo(2 / 3, 10);
    expect(r.rateExcludingExamples).toBeCloseTo(1 / 2, 10);
  });
});

describe('检测器校准（回答"你的规则凭什么可信"）', () => {
  it('precision / recall / F1 手算', () => {
    const r = detectorCalibration([
      { entity: 'A', rule_unsourced: true, human_unsourced: true },
      { entity: 'B', rule_unsourced: true, human_unsourced: false },
      { entity: 'C', rule_unsourced: false, human_unsourced: true },
      { entity: 'D', rule_unsourced: false, human_unsourced: false },
    ]);
    expect(r.tp).toBe(1);
    expect(r.fp).toBe(1);
    expect(r.fn).toBe(1);
    expect(r.tn).toBe(1);
    expect(r.precision).toBeCloseTo(0.5, 10);
    expect(r.recall).toBeCloseTo(0.5, 10);
    expect(r.f1).toBeCloseTo(0.5, 10);
    // 误报/漏报的具体样本必须能列出来，否则没法改词典
    expect(r.falsePositives).toEqual(['B']);
    expect(r.falseNegatives).toEqual(['C']);
  });
});

describe('锚点指标（修掉 v1 可 gaming 的漏洞）', () => {
  const mk = (id: string, text: string, anchor: string | null): Suggestion => ({
    id,
    case_id: 'case-1',
    run_id: 'run-1',
    run_index: 0,
    kind: 'improve',
    text,
    anchor_seg_id: anchor,
  });

  it('没绑锚点的建议不算覆盖，否则抄 JD 的词就能刷满', () => {
    const suggestions = [
      mk('a', '熟悉 React 与 TypeScript', 'S01'),
      mk('b', '建议补充 ECharts 与 Node.js 经验', null),
    ];
    const r = hardGateCoverage(suggestions, ['React', 'ECharts', 'Node.js']);
    expect(r.covered).toEqual(['React']);
    expect(r.missing).toEqual(['ECharts', 'Node.js']);
    expect(r.rate).toBeCloseTo(1 / 3, 10);
    expect(r.anchoredCount).toBe(1);
    expect(r.totalCount).toBe(2);
  });

  it('锚点覆盖率与无出处建议单列', () => {
    const r = anchorCoverage([mk('a', 'x', 'S01'), mk('b', 'y', null)]);
    expect(r.rate).toBeCloseTo(0.5, 10);
    expect(r.unsourcedSuggestions.map((s) => s.id)).toEqual(['b']);
  });
});

describe('LLM-judge 聚合与校准', () => {
  it('可执行性分布', () => {
    const r = executability([3, 3, 2, 1]);
    expect(r.mean).toBeCloseTo(2.25, 10);
    expect(r.rate3).toBeCloseTo(0.5, 10);
    expect(r.distribution[3]).toBe(2);
  });

  it('正反序合并消位置偏见', () => {
    expect(mergeOrderDebiased([3, 1], [1, 3])).toEqual([2, 2]);
  });

  it('judge 与人的一致性', () => {
    const r = judgeHumanAgreement([3, 2, 1, 3], [3, 2, 2, 2]);
    expect(r.n).toBe(4);
    expect(r.exact).toBeCloseTo(0.5, 10);
    expect(r.within1).toBeCloseTo(1, 10);
    expect(r.meanAbsDiff).toBeCloseTo(0.5, 10);
    expect(r.bias).toBeCloseTo(2.25 - 2.25, 10);
  });

  it('长度偏见过强要能报警', () => {
    expect(lengthBiasCorrelation([10, 20, 30, 40], [1, 2, 3, 3]).suspicious).toBe(true);
    expect(lengthBiasCorrelation([10, 20, 30, 40], [2, 3, 1, 3]).suspicious).toBe(false);
  });
});

describe('步骤级指标与死循环检测', () => {
  const mkSpan = (over: Partial<StepSpan> & { span_id: string }): StepSpan => ({
    parent_id: null,
    trace_id: 't1',
    type: 'tool',
    name: 'search',
    start: 0,
    end: 10,
    tokens: null,
    ...over,
  });

  it('同工具同参数重复 ≥3 次判定为死循环', () => {
    const spans = [1, 2, 3, 4].map((i) =>
      mkSpan({
        span_id: `s${i}`,
        name: 'search',
        start: i * 100,
        end: i * 100 + 10,
        attrs: { input_digest: 'same-args' },
      }),
    );
    const loops = detectLoops(spans);
    expect(loops).toHaveLength(1);
    expect(loops[0].count).toBe(4);
    expect(loops[0].basis).toBe('name+input_digest');
  });

  it('参数不同不算循环', () => {
    const spans = [1, 2, 3].map((i) =>
      mkSpan({ span_id: `s${i}`, attrs: { input_digest: `args-${i}` } }),
    );
    expect(detectLoops(spans)).toHaveLength(0);
  });

  it('没有 input_digest 时退化成按名字判，并且要如实标注依据', () => {
    const spans = [1, 2, 3].map((i) => mkSpan({ span_id: `s${i}` }));
    const loops = detectLoops(spans);
    expect(loops).toHaveLength(1);
    expect(loops[0].basis).toBe('name-only');
  });

  it('汇总指标：工具成功率、重试、成本瀑布、失败聚类', () => {
    const spans: StepSpan[] = [
      mkSpan({ span_id: 'root', parent_id: null, type: 'agent', name: 'run', start: 0, end: 100 }),
      mkSpan({ span_id: 'l1', parent_id: 'root', type: 'llm', name: 'parse', start: 0, end: 20, tokens: { input: 100, output: 50 } }),
      mkSpan({ span_id: 't1', parent_id: 'root', start: 20, end: 30, error: 'timeout' }),
      mkSpan({ span_id: 't2', parent_id: 'root', start: 30, end: 40, retry_of: 't1', error: 'timeout' }),
      mkSpan({ span_id: 't3', parent_id: 'root', start: 40, end: 50 }),
    ];
    const m = computeStepMetrics(spans);
    expect(m.spanCount).toBe(5);
    expect(m.toolCalls).toBe(3);
    expect(m.toolFailures).toBe(2);
    expect(m.toolSuccessRate).toBeCloseTo(1 / 3, 10);
    expect(m.retryCount).toBe(1);
    expect(m.stepCount).toBe(4);
    expect(m.totalTokens).toBe(150);
    expect(m.maxDepth).toBe(1);
    expect(m.failureClusters).toHaveLength(1);
    expect(m.failureClusters[0].count).toBe(2);
    expect(m.tokenWaterfall[0].name).toBe('parse');
  });
});

describe('pass^k', () => {
  const outcomes = [
    { run_id: 'm1__p1', case_id: 'A', run_index: 0, passed: true },
    { run_id: 'm1__p1', case_id: 'A', run_index: 1, passed: true },
    { run_id: 'm1__p1', case_id: 'A', run_index: 2, passed: true },
    { run_id: 'm1__p1', case_id: 'B', run_index: 0, passed: true },
    { run_id: 'm1__p1', case_id: 'B', run_index: 1, passed: true },
    { run_id: 'm1__p1', case_id: 'B', run_index: 2, passed: false },
    { run_id: 'm1__p1', case_id: 'C', run_index: 0, passed: true },
    { run_id: 'm1__p1', case_id: 'C', run_index: 1, passed: true },
  ];

  it('记录不足 k 次的 case 要单列，不能被悄悄算成失败', () => {
    const r = passK(outcomes, 3);
    expect(r.eligibleCases).toBe(2);
    expect(r.passedCases).toBe(1);
    expect(r.rate).toBe(0.5);
    expect(r.insufficientCases).toEqual(['C']);
  });

  it('pass^k 必须按配置分组，跨配置合并会算错', () => {
    // 同一个 case 在模型 m2 上也跑了 3 次且全过：如果按 case_id 单键合并，
    // A 会有 6 条记录，pass^3 会被算成"全部达标"，掩盖 m1 上的真实情况
    const mixed = [
      ...outcomes,
      { run_id: 'm2__p1', case_id: 'B', run_index: 0, passed: true },
      { run_id: 'm2__p1', case_id: 'B', run_index: 1, passed: true },
      { run_id: 'm2__p1', case_id: 'B', run_index: 2, passed: true },
    ];
    const got = passK(mixed, 3);
    // m1__p1 下 A 全过、B 挂一次；m2__p1 下 B 全过 —— 共 3 个可评估组，通过 2 个
    expect(got.eligibleCases).toBe(3);
    expect(got.passedCases).toBe(2);
  });

  it('稳定性分档：全过 / 全挂 / 时好时坏', () => {
    const r = stabilityBreakdown(outcomes, 3);
    expect(r.always).toBe(1);
    expect(r.never).toBe(0);
    expect(r.flaky).toBe(1);
    expect(r.flakyRate).toBeCloseTo(0.5, 10);
  });

  it('pass@k 的无偏估计，与朴素算法不同', () => {
    expect(passAtKUnbiased(3, 1, 2)).toBeCloseTo(2 / 3, 10);
    expect(passAtKUnbiased(10, 1, 10)).toBeCloseTo(1, 10);
    expect(passAtKUnbiased(4, 0, 2)).toBe(0);
    // 朴素算法：k 次里至少一次成功 = 1 - ((n-c)/n)^k = 1 - (2/3)^2 = 5/9 ≈ 0.5556
    const naive = 1 - Math.pow(2 / 3, 2);
    expect(passAtKUnbiased(3, 1, 2)).not.toBeCloseTo(naive, 3);
  });
});

describe('对比矩阵与显著性（不显著 ≠ 没变化）', () => {
  const mkRecords = (
    model: string,
    promptVersion: string,
    opts: { failCases?: number; score: number },
  ): RunRecord[] => {
    const rows: RunRecord[] = [];
    for (let i = 0; i < 24; i++) {
      const category = i % 2 === 0 ? 'app' : 'platform';
      const passed = i >= (opts.failCases ?? 0);
      rows.push({
        run_id: `${model}-${promptVersion}`,
        case_id: `case-${String(i).padStart(2, '0')}`,
        run_index: 0,
        model,
        prompt_version: promptVersion,
        passed,
        score: opts.score,
        cost_usd: 0.1,
        latency_ms: 1000,
        unsourced_rate: 0.4,
        anchor_coverage: 0.8,
        tags: { category, experience_level: 'rich', level: 'intern' },
      });
    }
    return rows;
  };

  it('24 组里只差 1 组 → 必须标「不显著」，否则就是在卖假胜利', () => {
    const base = mkRecords('modelA', 'p1', { score: 2.3 });
    const cand = mkRecords('modelB', 'p1', { failCases: 1, score: 2.34 });
    const row = compareRuns(base, cand);
    const passCell = row.cells.find((c) => c.metric === 'pass_rate');
    expect(passCell?.mcnemar?.b).toBe(1); // 基线对、候选错
    expect(passCell?.mcnemar?.c).toBe(0);
    expect(passCell?.significant).toBe(false);
    expect(passCell?.badge).toBe('不显著');
  });

  it('差异很大时标显著，并且方向正确', () => {
    const base = mkRecords('modelA', 'p1', { score: 1.2 });
    const cand = mkRecords('modelB', 'p1', { failCases: 22, score: 2.9 });
    const row = compareRuns(base, cand);
    const scoreCell = row.cells.find((c) => c.metric === 'exec_score');
    expect(scoreCell?.method).toBe('bootstrap');
    expect(scoreCell?.significant).toBe(true);
    expect(scoreCell?.direction).toBe('better');
    expect(scoreCell?.badge).toBe('显著更好');
  });

  it('成本指标是"越低越好"，涨了要标显著更差', () => {
    const base = mkRecords('modelA', 'p1', { score: 2 }).map((r) => ({ ...r, cost_usd: 0.05 }));
    const cand = mkRecords('modelB', 'p1', { score: 2 }).map((r) => ({ ...r, cost_usd: 0.4 }));
    const row = compareRuns(base, cand);
    const cost = row.cells.find((c) => c.metric === 'avg_cost');
    expect(cost?.significant).toBe(true);
    expect(cost?.direction).toBe('worse');
    expect(cost?.badge).toBe('显著更差');
  });

  it('主对比只用 run_index=0，重复运行不混进矩阵', () => {
    const base = mkRecords('modelA', 'p1', { score: 2 });
    const withRepeats = [...base, ...base.map((r) => ({ ...r, run_index: 1, passed: false }))];
    expect(firstRunOnly(withRepeats)).toHaveLength(24);
  });

  it('两侧没有共同 case 时返回空结果，**而不是抛异常**（否则整份报告写不出来）', () => {
    // 真实踩到：候选在某些 case 上全部跑失败 → 该切片两侧交集为空 →
    // 空数组进 bootstrap 抛错 → 报告在最后一步挂掉，已花的钱白搭。
    const base = mkRecords('modelA', 'p1', { score: 2 });
    const cand = mkRecords('modelB', 'p1', { score: 2 }).map((r) => ({
      ...r,
      case_id: `other-${r.case_id}`,
    }));
    const row = compareRuns(base, cand);
    expect(row.cells).toEqual([]);
    expect(row.base_model).toBe('modelA');
    expect(row.cand_model).toBe('modelB');
  });

  it('切片下钻：候选在该切片一条有效记录都没有 → 该切片不出结论，不炸', () => {
    const base = mkRecords('modelA', 'p1', { score: 2 });
    const cand = mkRecords('modelB', 'p1', { score: 2 }).filter((r) => r.tags.category === 'platform');
    // 基线有 app/platform 两个切片，候选只有 platform；
    // app 切片两侧交集为空 —— 以前这里会抛异常。
    expect(() => sliceDown(base, cand, ['category'])).not.toThrow();
    const findings = sliceDown(base, cand, ['category']);
    expect(findings.every((f) => f.slice_value === 'platform')).toBe(true);
  });

  it('切片下钻：样本少于 3 组的切片直接跳过，不出结论', () => {
    const rec = (i: number, category: string, model: string): RunRecord => ({
      run_id: `${model}-p1`,
      case_id: `case-${String(i).padStart(2, '0')}`,
      run_index: 0,
      model,
      prompt_version: 'p1',
      passed: true,
      score: 2,
      cost_usd: 0.1,
      latency_ms: 1000,
      unsourced_rate: 0.4,
      anchor_coverage: 0.8,
      tags: { category, experience_level: 'rich', level: 'intern' },
    });
    const base: RunRecord[] = [];
    const cand: RunRecord[] = [];
    let i = 0;
    for (const [category, n] of [['app', 4], ['platform', 2]] as Array<[string, number]>) {
      for (let k = 0; k < n; k++) {
        base.push(rec(i, category, 'modelA'));
        cand.push(rec(i, category, 'modelB'));
        i++;
      }
    }
    const findings = sliceDown(base, cand, ['category']);
    expect([...new Set(findings.map((f) => f.slice_value))]).toEqual(['app']);
  });

  it('切片报告必须折叠资源类差异，否则成本会在每个切片上刷屏、挤掉质量退化', () => {
    const rec = (
      i: number,
      category: string,
      model: string,
      opts: { score: number; cost: number },
    ): RunRecord => ({
      run_id: `${model}-p1`,
      case_id: `case-${String(i).padStart(2, '0')}`,
      run_index: 0,
      model,
      prompt_version: 'p1',
      passed: true,
      score: opts.score,
      cost_usd: opts.cost,
      latency_ms: 1000,
      unsourced_rate: 0.4,
      anchor_coverage: 0.8,
      tags: { category, experience_level: 'rich', level: 'intern' },
    });

    const base: RunRecord[] = [];
    const cand: RunRecord[] = [];
    let i = 0;
    // 3 个类别各 5 组。候选在所有类别上都贵 0.03（资源类差异 ×3），
    // 但只在 platform 上可执行性掉了 1.0（能力类差异 ×1）。
    for (const category of ['app', 'platform', 'data']) {
      for (let k = 0; k < 5; k++) {
        base.push(rec(i, category, 'modelA', { score: 2.5, cost: 0.06 }));
        cand.push(
          rec(i, category, 'modelB', {
            score: category === 'platform' ? 1.5 : 2.5,
            cost: 0.09,
          }),
        );
        i++;
      }
    }

    const findings = sliceDown(base, cand, ['category']);
    const part = partitionFindings(findings, 2);

    // 能力类：platform 的可执行性退化必须完整保留，一条都不能被折叠
    expect(part.quality.map((f) => f.slice_value)).toContain('platform');
    expect(part.quality.every((f) => f.cell.metric === 'exec_score')).toBe(true);

    // 资源类：3 个类别都有成本差异，但只展示 2 条，剩下 1 条折叠
    expect(part.resource).toHaveLength(2);
    expect(part.resource.every((f) => f.cell.metric === 'avg_cost')).toBe(true);
    expect(part.resourceCollapsed).toBe(1);
  });
});
