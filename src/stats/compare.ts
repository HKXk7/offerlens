import { pairedBootstrapCI } from './bootstrap.js';
import { mcnemarFromPairs } from './mcnemar.js';
import { mean, percentiles, safeDiv } from './rank.js';

/**
 * 对比矩阵 + 显著性（策划书模块 5，不可砍的那一块）。
 *
 * 这个模块存在的唯一理由：
 *   "可执行率 2.31 → 2.34" 在 24 组上大概率只是 3 条 case 的波动，
 *   但 UI 如果不标出来，算法同学会把它当成一次胜利，然后带着一个假结论上线。
 *   所以每个格子必须带"显著 / 不显著"。
 */

export interface RunTags {
  category: string;
  experience_level: string;
  level: string;
}

export interface RunRecord {
  run_id: string;
  case_id: string;
  run_index: number;
  model: string;
  prompt_version: string;
  passed: boolean;
  /** judge 或规则给出的连续得分（可执行性 1–3） */
  score: number;
  cost_usd: number;
  latency_ms: number;
  /**
   * 无源实体率（严口径）。这是本项目的招牌指标，
   * 必须进主对比矩阵 —— 只报"达标率 0% vs 4%"而把真正在动的那个数藏起来，是耍流氓。
   */
  unsourced_rate: number;
  /** 带锚点覆盖率（建议里有多少条真的挂到了简历段 ID 上） */
  anchor_coverage: number;
  tags: RunTags;
}

export interface MetricDef {
  key: string;
  label: string;
  higherIsBetter: boolean;
  /** binary 用 McNemar 判显著，continuous 用 paired bootstrap */
  kind: 'binary' | 'continuous';
  compute(rows: readonly RunRecord[]): number;
  /** 连续指标的逐 case 取值，用于配对 bootstrap */
  perCase(rows: readonly RunRecord[]): number[];
}

/** 主对比只用 run_index = 0，重复运行不混进主矩阵（否则同一组被算多次，方差被低估） */
export function firstRunOnly(rows: readonly RunRecord[]): RunRecord[] {
  return rows.filter((r) => r.run_index === 0);
}

export const DEFAULT_METRICS: readonly MetricDef[] = [
  {
    key: 'pass_rate',
    label: '达标率',
    higherIsBetter: true,
    kind: 'binary',
    compute: (rows) => safeDiv(rows.filter((r) => r.passed).length, rows.length),
    perCase: (rows) => rows.map((r) => (r.passed ? 1 : 0)),
  },
  {
    key: 'exec_score',
    label: '建议可执行性（1-3）',
    higherIsBetter: true,
    kind: 'continuous',
    compute: (rows) => mean(rows.map((r) => r.score)),
    perCase: (rows) => rows.map((r) => r.score),
  },
  {
    key: 'unsourced_rate',
    label: '无源实体率',
    higherIsBetter: false,
    kind: 'continuous',
    compute: (rows) => mean(rows.map((r) => r.unsourced_rate)),
    perCase: (rows) => rows.map((r) => r.unsourced_rate),
  },
  {
    key: 'anchor_coverage',
    label: '带锚点覆盖率',
    higherIsBetter: true,
    kind: 'continuous',
    compute: (rows) => mean(rows.map((r) => r.anchor_coverage)),
    perCase: (rows) => rows.map((r) => r.anchor_coverage),
  },
  {
    key: 'avg_cost',
    label: '单次成本（¥）',
    higherIsBetter: false,
    kind: 'continuous',
    compute: (rows) => mean(rows.map((r) => r.cost_usd)),
    perCase: (rows) => rows.map((r) => r.cost_usd),
  },
  {
    key: 'p95_latency',
    label: 'P95 延迟（ms）',
    higherIsBetter: false,
    kind: 'continuous',
    compute: (rows) => (rows.length === 0 ? 0 : percentiles(rows.map((r) => r.latency_ms), [0.95])[0]),
    perCase: (rows) => rows.map((r) => r.latency_ms),
  },
];

export interface CompareCell {
  metric: string;
  label: string;
  base: number;
  cand: number;
  delta: number;
  /** 变化方向是否"好"（考虑了 higherIsBetter） */
  direction: 'better' | 'worse' | 'same';
  significant: boolean;
  method: 'mcnemar' | 'bootstrap';
  /** 二元指标：McNemar 的 b / c / p */
  mcnemar?: { b: number; c: number; p: number };
  /** 连续指标：paired bootstrap 的 95% CI */
  ci?: { lo: number; hi: number; excludesZero: boolean };
  /** 配对样本数 */
  n: number;
  /** 可以直接显示在角标上的文案 */
  badge: string;
}

export interface CompareRow {
  base_model: string;
  base_prompt_version: string;
  cand_model: string;
  cand_prompt_version: string;
  cells: CompareCell[];
}

function orderByCase(rows: readonly RunRecord[]): Map<string, RunRecord> {
  const m = new Map<string, RunRecord>();
  for (const r of rows) {
    if (!m.has(r.case_id)) m.set(r.case_id, r);
  }
  return m;
}

export function badgeOf(
  significant: boolean,
  delta: number,
  higherIsBetter: boolean,
): string {
  if (!significant) return '不显著';
  if (delta === 0) return '无变化';
  const improved = higherIsBetter ? delta > 0 : delta < 0;
  return improved ? '显著更好' : '显著更差';
}

export interface CompareOptions {
  metrics?: readonly MetricDef[];
  bootstrapIters?: number;
  bootstrapSeed?: number;
  alpha?: number;
}

export function compareRuns(
  base: readonly RunRecord[],
  cand: readonly RunRecord[],
  opts: CompareOptions = {},
): CompareRow {
  const metrics = opts.metrics ?? DEFAULT_METRICS;
  const baseMap = orderByCase(firstRunOnly(base));
  const candMap = orderByCase(firstRunOnly(cand));

  // 只保留两边都有的 case —— 配对比较的前提
  const commonCases = [...baseMap.keys()].filter((c) => candMap.has(c)).sort();

  // 交集为空时**必须提前返回**，不能往下走。
  // 这条路径是真实踩出来的：切片下钻会给"基线有这个切片、候选在这个切片里
  // 一条有效记录都没有"的组合调用本函数（候选在该切片全部跑失败时就会这样），
  // 于是 commonCases 为空 → 空数组进 bootstrap → 抛异常 → **整份报告写不出来**。
  // 没有配对样本 = 这个格子做不了比较，应该说"无数据"，而不是让整批结果陪葬。
  if (commonCases.length === 0) {
    return {
      base_model: base[0]?.model ?? '(空)',
      base_prompt_version: base[0]?.prompt_version ?? '(空)',
      cand_model: cand[0]?.model ?? '(空)',
      cand_prompt_version: cand[0]?.prompt_version ?? '(空)',
      cells: [],
    };
  }

  const b0 = base[0];
  const c0 = cand[0];
  const cells: CompareCell[] = [];

  for (const metric of metrics) {
    const baseRows = commonCases.map((c) => baseMap.get(c) as RunRecord);
    const candRows = commonCases.map((c) => candMap.get(c) as RunRecord);
    const baseVal = metric.compute(baseRows);
    const candVal = metric.compute(candRows);
    const delta = candVal - baseVal;

    if (metric.kind === 'binary') {
      const res = mcnemarFromPairs(
        baseRows.map((r) => r.passed),
        candRows.map((r) => r.passed),
        { alpha: opts.alpha ?? 0.05 },
      );
      cells.push({
        metric: metric.key,
        label: metric.label,
        base: baseVal,
        cand: candVal,
        delta,
        direction: delta === 0 ? 'same' : (metric.higherIsBetter ? delta > 0 : delta < 0) ? 'better' : 'worse',
        significant: res.significant,
        method: 'mcnemar',
        mcnemar: { b: res.b, c: res.c, p: res.p },
        n: commonCases.length,
        badge: badgeOf(res.significant, delta, metric.higherIsBetter),
      });
    } else {
      const a = metric.perCase(baseRows);
      const b = metric.perCase(candRows);
      const ci = pairedBootstrapCI(a, b, {
        iters: opts.bootstrapIters ?? 10000,
        seed: opts.bootstrapSeed ?? 42,
        alpha: opts.alpha ?? 0.05,
      });
      cells.push({
        metric: metric.key,
        label: metric.label,
        base: baseVal,
        cand: candVal,
        delta,
        direction: delta === 0 ? 'same' : (metric.higherIsBetter ? delta > 0 : delta < 0) ? 'better' : 'worse',
        significant: ci.excludesZero,
        method: 'bootstrap',
        ci: { lo: ci.lo, hi: ci.hi, excludesZero: ci.excludesZero },
        n: commonCases.length,
        badge: badgeOf(ci.excludesZero, delta, metric.higherIsBetter),
      });
    }
  }

  return {
    base_model: b0?.model ?? '(空)',
    base_prompt_version: b0?.prompt_version ?? '(空)',
    cand_model: c0?.model ?? '(空)',
    cand_prompt_version: c0?.prompt_version ?? '(空)',
    cells,
  };
}

/* ------------------------------------------------------------------ */
/* 切片下钻                                                            */
/* ------------------------------------------------------------------ */

export type SliceKey = keyof RunTags;

export function sliceByTag(rows: readonly RunRecord[], key: SliceKey): Map<string, RunRecord[]> {
  const out = new Map<string, RunRecord[]>();
  for (const r of rows) {
    const v = r.tags[key];
    const arr = out.get(v) ?? [];
    arr.push(r);
    out.set(v, arr);
  }
  return out;
}

/**
 * 整体持平但某个子集退化 —— 这是这个项目最想讲出来的那个故事。
 * 对每个切片分别跑一次配对比较，只留下"显著"的格子。
 */
export interface SliceFinding {
  slice_key: SliceKey;
  slice_value: string;
  n: number;
  cell: CompareCell;
}

export function sliceDown(
  base: readonly RunRecord[],
  cand: readonly RunRecord[],
  sliceKeys: readonly SliceKey[] = ['category', 'experience_level', 'level'],
  opts: CompareOptions = {},
): SliceFinding[] {
  const findings: SliceFinding[] = [];
  for (const key of sliceKeys) {
    const baseGroups = sliceByTag(firstRunOnly(base), key);
    for (const [value, rows] of baseGroups) {
      const caseIds = new Set(rows.map((r) => r.case_id));
      const candRows = firstRunOnly(cand).filter((r) => caseIds.has(r.case_id));
      if (caseIds.size < 3) continue; // 少于 3 组的切片不做结论——样本太小，写出来是误导
      const row = compareRuns(rows, candRows, opts);
      for (const cell of row.cells) {
        findings.push({ slice_key: key, slice_value: value, n: caseIds.size, cell });
      }
    }
  }
  return findings;
}

/* ------------------------------------------------------------------ */
/* Markdown 导出（模块 6 的降级形态：不做分享链接，先能导出）           */
/* ------------------------------------------------------------------ */

export function compareToMarkdown(row: CompareRow, title = '评测对比'): string {
  const lines: string[] = [];
  lines.push(`# ${title}`);
  lines.push('');
  lines.push(`- 基线：\`${row.base_model}\` / prompt \`${row.base_prompt_version}\``);
  lines.push(`- 候选：\`${row.cand_model}\` / prompt \`${row.cand_prompt_version}\``);
  lines.push('');
  lines.push('| 指标 | 基线 | 候选 | 变化 | 显著性 | 检验 | 样本 |');
  lines.push('| --- | ---: | ---: | ---: | --- | --- | ---: |');
  for (const c of row.cells) {
    const fmt = (v: number) => (Math.abs(v) < 10 ? v.toFixed(3) : v.toFixed(1));
    const sig =
      c.method === 'mcnemar'
        ? `p=${c.mcnemar?.p.toFixed(4)}`
        : `95% CI [${c.ci?.lo.toFixed(3)}, ${c.ci?.hi.toFixed(3)}]`;
    lines.push(
      `| ${c.label} | ${fmt(c.base)} | ${fmt(c.cand)} | ${c.delta >= 0 ? '+' : ''}${fmt(c.delta)} | ${c.badge} | ${sig} | ${c.n} |`,
    );
  }
  lines.push('');
  lines.push(
    '> 「不显著」不等于没有变化，只说明这个变化在配对检验下还站不住；样本量小的时候不要据此做上线决策。',
  );
  return lines.join('\n');
}

/**
 * 报告排序：先看"能力类"指标，成本/延迟垫底。
 * 否则一批成本差异会把"某个子集上质量真的退化了"这条结论挤到看不见。
 */
const METRIC_PRIORITY: Record<string, number> = {
  pass_rate: 0,
  unsourced_rate: 1,
  exec_score: 2,
  anchor_coverage: 3,
  avg_cost: 8,
  p95_latency: 9,
};

/**
 * 资源类指标（成本 / 延迟）。
 *
 * 这两类指标的切片差异几乎总是"整体差异在每个切片上的复读"——
 * 一个模型整体贵 0.03 元，那么在 6 个切片上就会各出现一条"成本显著更差"。
 * 它们会挤掉真正有价值的结论（"整体持平，但 platform 这类岗位质量掉了"），
 * 所以报告里必须折叠。
 */
const RESOURCE_METRICS = new Set(['avg_cost', 'p95_latency']);

export function isResourceMetric(metric: string): boolean {
  return RESOURCE_METRICS.has(metric);
}

export function sortFindings(findings: readonly SliceFinding[]): SliceFinding[] {
  return findings.slice().sort((a, b) => {
    const pa = METRIC_PRIORITY[a.cell.metric] ?? 5;
    const pb = METRIC_PRIORITY[b.cell.metric] ?? 5;
    if (pa !== pb) return pa - pb;
    // 同为退化时，退化幅度大的排前面
    if (a.cell.direction !== b.cell.direction) return a.cell.direction === 'worse' ? -1 : 1;
    return Math.abs(b.cell.delta) - Math.abs(a.cell.delta);
  });
}

export interface PartitionedFindings {
  /** 能力类（达标率 / 可执行性 / 锚点覆盖…）：全部保留 */
  quality: SliceFinding[];
  /** 资源类（成本 / 延迟）：只留最值得看的几条 */
  resource: SliceFinding[];
  /** 被折叠掉的资源类条数 */
  resourceCollapsed: number;
}

/**
 * 把显著切片结论分成「能力类」和「资源类」。
 * 资源类默认只保留前 `resourceKeep` 条（默认 2），其余折叠成计数。
 */
export function partitionFindings(
  findings: readonly SliceFinding[],
  resourceKeep = 2,
): PartitionedFindings {
  const sig = sortFindings(findings.filter((f) => f.cell.significant));
  const quality = sig.filter((f) => !isResourceMetric(f.cell.metric));
  const allResource = sig.filter((f) => isResourceMetric(f.cell.metric));
  const resource = allResource.slice(0, resourceKeep);
  return { quality, resource, resourceCollapsed: allResource.length - resource.length };
}

const SLICE_TABLE_HEAD = [
  '| 切片 | 取值 | 指标 | 基线 | 候选 | 方向 | 样本 |',
  '| --- | --- | --- | ---: | ---: | --- | ---: |',
];

function sliceRow(f: SliceFinding): string {
  return `| ${f.slice_key} | ${f.slice_value} | ${f.cell.label} | ${f.cell.base.toFixed(3)} | ${f.cell.cand.toFixed(3)} | ${f.cell.badge} | ${f.n} |`;
}

export function sliceFindingsToMarkdown(findings: readonly SliceFinding[]): string {
  const { quality, resource, resourceCollapsed } = partitionFindings(findings);
  if (quality.length === 0 && resource.length === 0) {
    return '切片下钻：没有任何切片上的差异达到显著。\n';
  }

  const lines: string[] = [];
  if (quality.length > 0) {
    lines.push('## 切片下钻：能力类指标的显著差异', '', ...SLICE_TABLE_HEAD);
    for (const f of quality) lines.push(sliceRow(f));
    lines.push('');
  } else {
    lines.push('## 切片下钻：能力类指标的显著差异', '', '无 —— 没有哪个切片上出现显著的能力差异。', '');
  }
  if (resource.length > 0) {
    lines.push('## 切片下钻：资源类指标（成本 / 延迟）', '', ...SLICE_TABLE_HEAD);
    for (const f of resource) lines.push(sliceRow(f));
    if (resourceCollapsed > 0) {
      lines.push(
        '',
        `> 另有 ${resourceCollapsed} 条资源类差异与上表方向一致（成本/延迟的整体差异在每个切片上复读），已折叠。`,
      );
    }
    lines.push('');
  }
  return lines.join('\n');
}
