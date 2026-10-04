/**
 * Trace JSONL schema —— 全项目最先要定下来的东西（策划书 8.1 "今天（D1）"）。
 *
 * 目标：schema 定不下来，运行引擎、指标、对比页全部会卡住。
 * 所以这里只有 8 个必需字段 + 1 个可选字段，够用且不会被后面的需求推翻。
 *
 * 一行 JSONL = 一个 span。一次 agent 运行（一个 trace）= 一个 trace_id 下的一堆 span。
 *
 * 字段命名大致对齐 OpenTelemetry GenAI 语义约定（span_id / parent_id / start / end /
 * gen_ai.usage.* 那套），但不引入 OTel SDK——4 周版要的是可控性和最小依赖。
 */

export type SpanType =
  /** agent 单次运行的整体 span（root） */
  | 'agent'
  /** 一次模型调用 */
  | 'llm'
  /** 一次工具/函数调用 */
  | 'tool'
  /** 检索（本 4 周版基本用不到，保留以免以后改 schema） */
  | 'retrieval'
  /** 前端渲染或后处理 */
  | 'render';

export const SPAN_TYPES: readonly SpanType[] = ['agent', 'llm', 'tool', 'retrieval', 'render'];

export interface TokenUsage {
  input: number;
  output: number;
}

/** 一个 span = JSONL 的一行。 */
export interface StepSpan {
  /** 必需 1/8 · 全局唯一，建议 `${trace_id}-${序号}` */
  span_id: string;
  /** 必需 2/8 · root span 为 null */
  parent_id: string | null;
  /** 必需 3/8 · 一次 agent 运行一个 trace_id */
  trace_id: string;
  /** 必需 4/8 */
  type: SpanType;
  /** 必需 5/8 · 如 'parse_resume' / 'extract_jd' / 'match' / 'generate' / 模型名 */
  name: string;
  /** 必需 6/8 · epoch 毫秒 */
  start: number;
  /** 必需 7/8 · epoch 毫秒，必须 >= start */
  end: number;
  /** 必需 8/8 · llm span 才有；其他类型为 null */
  tokens: TokenUsage | null;
  /** 可选 · 指向被本次重试的那次调用的 span_id，可追溯"重试次数"指标 */
  retry_of?: string | null;
  /** 可选 · 失败时的错误类型（超时 / 限流 / 格式错误 / 内容拦截 …） */
  error?: string | null;
  /**
   * 可选扩展位。用于放不该进 schema 顶层的东西，例如：
   *   { input_digest, output_digest, prompt_version, model, cost_usd, anchor_seg_ids, attempt }
   * 放 digest 而不是全文，是为了让 span 行能安全入库（全文落 JSONL 文件）。
   */
  attrs?: Record<string, unknown>;
}

/** 一次 agent 运行的汇总（也可以从 spans 现算，落库是为了列表页不必读 JSONL）。 */
export interface TraceSummary {
  trace_id: string;
  run_id: string;
  case_id: string;
  run_index: number;
  status: 'ok' | 'failed' | 'aborted';
  steps_count: number;
  total_tokens: number;
  cost_usd: number;
  latency_ms: number;
  error_type: string | null;
}

/* ------------------------------------------------------------------ */
/* 校验                                                                */
/* ------------------------------------------------------------------ */

export interface ValidationIssue {
  span_id: string | null;
  field: string;
  message: string;
}

export function validateSpan(input: unknown, index = -1): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const where = index >= 0 ? `第 ${index + 1} 行` : 'span';
  if (typeof input !== 'object' || input === null) {
    return [{ span_id: null, field: '-', message: `${where} 不是对象` }];
  }
  const s = input as Record<string, unknown>;
  const id = typeof s.span_id === 'string' ? s.span_id : null;

  const requireString = (field: string, nullable = false) => {
    const v = s[field];
    if (v === null) {
      if (!nullable) issues.push({ span_id: id, field, message: '不能为 null' });
      return;
    }
    if (typeof v !== 'string' || v.length === 0) {
      issues.push({ span_id: id, field, message: '需要非空字符串' });
    }
  };

  requireString('span_id');
  requireString('trace_id');
  requireString('name');
  if (s.parent_id !== null && typeof s.parent_id !== 'string') {
    issues.push({ span_id: id, field: 'parent_id', message: '需要字符串或 null' });
  }
  if (!SPAN_TYPES.includes(s.type as SpanType)) {
    issues.push({
      span_id: id,
      field: 'type',
      message: `需要是 ${SPAN_TYPES.join(' / ')} 之一，收到 ${String(s.type)}`,
    });
  }
  for (const field of ['start', 'end'] as const) {
    const v = s[field];
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      issues.push({ span_id: id, field, message: '需要数字（epoch 毫秒）' });
    }
  }
  if (typeof s.start === 'number' && typeof s.end === 'number' && s.end < s.start) {
    issues.push({ span_id: id, field: 'end', message: `end (${s.end}) 小于 start (${s.start})` });
  }
  if (s.tokens !== null) {
    const t = s.tokens as Record<string, unknown> | undefined;
    if (typeof t !== 'object' || t === null) {
      issues.push({ span_id: id, field: 'tokens', message: '需要 { input, output } 或 null' });
    } else {
      for (const k of ['input', 'output'] as const) {
        if (typeof t[k] !== 'number' || (t[k] as number) < 0) {
          issues.push({ span_id: id, field: `tokens.${k}`, message: '需要非负数字' });
        }
      }
    }
  } else if (s.tokens === undefined) {
    issues.push({ span_id: id, field: 'tokens', message: '需要显式写 null（不要省略）' });
  }
  return issues;
}

export function validateTrace(spans: readonly unknown[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  spans.forEach((s, i) => issues.push(...validateSpan(s, i)));

  const list = spans as StepSpan[];
  const ids = new Set<string>();
  for (const s of list) {
    if (s && typeof s.span_id === 'string') {
      if (ids.has(s.span_id)) {
        issues.push({ span_id: s.span_id, field: 'span_id', message: '重复的 span_id' });
      }
      ids.add(s.span_id);
    }
  }
  for (const s of list) {
    if (s && s.parent_id !== null && typeof s.parent_id === 'string' && !ids.has(s.parent_id)) {
      issues.push({
        span_id: s.span_id ?? null,
        field: 'parent_id',
        message: `引用了不存在的父 span：${s.parent_id}`,
      });
    }
  }
  return issues;
}

/* ------------------------------------------------------------------ */
/* span 树                                                             */
/* ------------------------------------------------------------------ */

export interface SpanNode {
  span: StepSpan;
  children: SpanNode[];
  depth: number;
}

/** 按 parent_id 组树。注意：不做"假设线性"的假设——并行工具调用天然是多叉的。 */
export function buildSpanTree(spans: readonly StepSpan[]): SpanNode[] {
  const byId = new Map<string, SpanNode>();
  for (const span of spans) byId.set(span.span_id, { span, children: [], depth: 0 });

  const roots: SpanNode[] = [];
  for (const node of byId.values()) {
    const pid = node.span.parent_id;
    const parent = pid === null ? undefined : byId.get(pid);
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  const walk = (node: SpanNode, depth: number) => {
    node.depth = depth;
    node.children.sort((a, b) => a.span.start - b.span.start);
    for (const c of node.children) walk(c, depth + 1);
  };
  roots.sort((a, b) => a.span.start - b.span.start);
  for (const r of roots) walk(r, 0);
  return roots;
}

export function flattenTree(nodes: readonly SpanNode[]): SpanNode[] {
  const out: SpanNode[] = [];
  const walk = (n: SpanNode) => {
    out.push(n);
    n.children.forEach(walk);
  };
  nodes.forEach(walk);
  return out;
}
