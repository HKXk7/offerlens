import type { StepSpan } from '../schema/trace.js';
import { buildSpanTree } from '../schema/trace.js';
import { percentiles } from '../stats/rank.js';

/**
 * 步骤级指标（策划书模块 3，4 周版保留）。
 *
 * 死循环检测是这里最值钱的一个：
 * agent 卡在"同一个工具、同一组参数反复调用"是最常见的烧钱方式，
 * 而且它在任务成功率上是看不出来的——任务最后可能还是"成功"了，只是花了 30 块钱。
 */

export interface LoopHit {
  key: string;
  count: number;
  span_ids: string[];
  firstStart: number;
  lastEnd: number;
  /** 判定依据：有 input_digest 用 digest（"同工具同参数"），没有就只能退化成按名字判（更宽松） */
  basis: 'name+input_digest' | 'name-only';
}

export interface DetectLoopOptions {
  /** 同一 key 重复达到这个次数就算循环，默认 3 */
  minRepeat?: number;
  /** 只看这两类 span */
  types?: readonly string[];
}

/**
 * 死循环检测：同一工具 + 同一组参数（input_digest）重复 ≥ N 次。
 *
 * 诚实说明：只有当 span 里带了 attrs.input_digest 时才是严格意义上的"同参数"。
 * 没有 digest 的时候会退化成"同名字重复"，误报会明显变多——
 * 所以返回值里带 basis 字段，报告里也要写清楚这次是怎么判的。
 */
export function detectLoops(
  spans: readonly StepSpan[],
  opts: DetectLoopOptions = {},
): LoopHit[] {
  const minRepeat = opts.minRepeat ?? 3;
  const types = new Set(opts.types ?? ['tool', 'llm']);

  const groups = new Map<string, StepSpan[]>();
  const basisOf = new Map<string, LoopHit['basis']>();

  for (const s of spans) {
    if (!types.has(s.type)) continue;
    const digest = s.attrs && typeof s.attrs.input_digest === 'string' ? s.attrs.input_digest : null;
    const basis: LoopHit['basis'] = digest ? 'name+input_digest' : 'name-only';
    const key = `${s.type}|${s.name}|${digest ?? '*'}`;
    const arr = groups.get(key) ?? [];
    arr.push(s);
    groups.set(key, arr);
    basisOf.set(key, basis);
  }

  const hits: LoopHit[] = [];
  for (const [key, arr] of groups) {
    if (arr.length < minRepeat) continue;
    const sorted = arr.slice().sort((a, b) => a.start - b.start);
    hits.push({
      key,
      count: arr.length,
      span_ids: sorted.map((s) => s.span_id),
      firstStart: sorted[0].start,
      lastEnd: sorted[sorted.length - 1].end,
      basis: basisOf.get(key) ?? 'name-only',
    });
  }
  return hits.sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

/* ------------------------------------------------------------------ */

export interface FailureCluster {
  name: string;
  error: string;
  count: number;
}

export interface StepMetrics {
  spanCount: number;
  byType: Record<string, number>;
  /** 工具调用次数（不含 llm） */
  toolCalls: number;
  toolFailures: number;
  /** 工具调用成功率 */
  toolSuccessRate: number;
  /** 有 retry_of 的 span 数 */
  retryCount: number;
  /** 重试链长度 ≥ 2 的次数（连续重试同一个东西） */
  retryChains: number;
  /** span 树最大深度 */
  maxDepth: number;
  /** 有效步骤数（llm + tool），衡量 agent 跑了多少步 */
  stepCount: number;
  totalTokens: number;
  /** token 消耗最多的前几个 span —— 成本瀑布的原料 */
  tokenWaterfall: Array<{ name: string; type: string; tokens: number }>;
  failureClusters: FailureCluster[];
  loops: LoopHit[];
  durationMs: number;
  /** 单个 span 耗时的分位数（不是平均值：长尾才是用户体验） */
  spanDurationP50: number;
  spanDurationP95: number;
  spanDurationMax: number;
}

export function computeStepMetrics(
  spans: readonly StepSpan[],
  opts: DetectLoopOptions = {},
): StepMetrics {
  const byType: Record<string, number> = {};
  let toolCalls = 0;
  let toolFailures = 0;
  let retryCount = 0;
  let totalTokens = 0;
  const durations: number[] = [];
  const failures = new Map<string, FailureCluster>();
  const retryByTarget = new Map<string, number>();

  let minStart = Infinity;
  let maxEnd = -Infinity;

  for (const s of spans) {
    byType[s.type] = (byType[s.type] ?? 0) + 1;
    if (s.type === 'tool') {
      toolCalls++;
      if (s.error) toolFailures++;
    }
    if (s.retry_of) {
      retryCount++;
      retryByTarget.set(s.retry_of, (retryByTarget.get(s.retry_of) ?? 0) + 1);
    }
    if (s.tokens) totalTokens += s.tokens.input + s.tokens.output;
    durations.push(Math.max(0, s.end - s.start));
    if (s.error) {
      const key = `${s.name}||${s.error}`;
      const cur = failures.get(key);
      if (cur) cur.count++;
      else failures.set(key, { name: s.name, error: s.error, count: 1 });
    }
    minStart = Math.min(minStart, s.start);
    maxEnd = Math.max(maxEnd, s.end);
  }

  const roots = buildSpanTree(spans);
  let maxDepth = 0;
  const walk = (nodes: typeof roots) => {
    for (const n of nodes) {
      maxDepth = Math.max(maxDepth, n.depth);
      walk(n.children);
    }
  };
  walk(roots);

  const tokenWaterfall = spans
    .filter((s) => s.tokens !== null)
    .map((s) => ({
      name: s.name,
      type: s.type,
      tokens: (s.tokens?.input ?? 0) + (s.tokens?.output ?? 0),
    }))
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, 5);

  const [p50, p95, max] = durations.length > 0 ? percentiles(durations, [0.5, 0.95, 1]) : [0, 0, 0];

  return {
    spanCount: spans.length,
    byType,
    toolCalls,
    toolFailures,
    toolSuccessRate: toolCalls === 0 ? 1 : (toolCalls - toolFailures) / toolCalls,
    retryCount,
    retryChains: [...retryByTarget.values()].filter((n) => n >= 2).length,
    maxDepth,
    stepCount: (byType.llm ?? 0) + (byType.tool ?? 0),
    totalTokens,
    tokenWaterfall,
    failureClusters: [...failures.values()].sort((a, b) => b.count - a.count),
    loops: detectLoops(spans, opts),
    durationMs: Number.isFinite(minStart) ? maxEnd - minStart : 0,
    spanDurationP50: p50,
    spanDurationP95: p95,
    spanDurationMax: max,
  };
}
