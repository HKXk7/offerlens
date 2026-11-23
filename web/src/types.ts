// 与后端 src/server/analyze.ts 返回的 JSON 一一对应。

export interface ProfileMeta {
  run_id: string;
  model: string;
  model_label: string;
  provider: string;
  prompt_version: string;
  platform: string;
}

export interface JudgeMeta {
  model: string;
  label: string;
  disagreement_rate: number;
}

export interface DatasetMeta {
  id: string;
  version: string;
  seed: number;
}

export interface LeaderboardRow {
  run_id: string;
  model: string;
  model_label: string;
  provider: string;
  prompt_version: string;
  total_runs: number;
  output_count: number;
  no_output_count: number;
  output_rate: number;
  unsourced_rate: number;
  unsourced_excl_example: number;
  gate_coverage: number;
  anchor_coverage: number;
  pass_rate: number;
  pass_k: number;
  exec_score: number | null;
  avg_cost_cny: number;
  p95_latency_ms: number;
  stability: { always: number; never: number; flaky: number; flaky_rate: number };
}

export interface CompareCell {
  metric: string;
  label: string;
  base: number;
  cand: number;
  delta: number;
  direction: 'better' | 'worse' | 'same';
  significant: boolean;
  method: 'mcnemar' | 'bootstrap';
  mcnemar?: { b: number; c: number; p: number };
  ci?: { lo: number; hi: number; excludesZero: boolean };
  n: number;
  badge: string;
}

export interface SliceFinding {
  slice_key: string;
  slice_value: string;
  n: number;
  cell: CompareCell;
}

export interface CompareResult {
  base: ProfileMeta;
  cand: ProfileMeta;
  matrix: {
    base_model: string;
    base_prompt_version: string;
    cand_model: string;
    cand_prompt_version: string;
    cells: CompareCell[];
  };
  slice: {
    quality: SliceFinding[];
    resource: SliceFinding[];
    resourceCollapsed: number;
  };
  crossPlatform: boolean;
}

export interface MetaResponse {
  profiles: ProfileMeta[];
  judge: JudgeMeta | null;
  caseCount: number;
  dataset: DatasetMeta;
  generatedAt: string;
  dataSource: 'real' | 'demo';
  /** 无 .env 时为只读演示（线上部署）：真实跑批被禁用，仅 dry-run 可跑 */
  readonly?: boolean;
}

export interface LeaderboardResponse {
  leaderboard: LeaderboardRow[];
  judge: JudgeMeta | null;
  generatedAt: string;
  dataSource: 'real' | 'demo';
}

/* ---------- case 详情 + trace 瀑布图 ---------- */

export type SpanType = 'agent' | 'llm' | 'tool' | 'retrieval' | 'render';

export interface Span {
  span_id: string;
  parent_id: string | null;
  trace_id: string;
  type: SpanType;
  name: string;
  start: number;
  end: number;
  tokens: { input: number; output: number } | null;
  error?: string | null;
  attrs?: Record<string, unknown>;
}

export interface CaseSuggestion {
  id: string;
  kind: 'improve' | 'missing' | 'hit';
  text: string;
  anchor_seg_id: string | null;
}

export interface CaseRunDetail {
  run_index: number;
  error: string | null;
  input_tokens: number;
  output_tokens: number;
  cost_cny: number;
  latency_ms: number;
  invalid_anchors: string[];
  suggestions: CaseSuggestion[];
  spans: Span[];
}

export interface CaseMeta {
  case_id: string;
  tags: { category: string; experience_level: string; level: string };
  resume_headline: string;
  resume_anon_id: string;
  jd_title: string;
  is_hard_negative: boolean;
  is_golden: boolean;
}

export interface CaseDetailResult {
  caseId: string;
  resume: {
    anon_id: string;
    headline: string;
    experience_level: string;
    segments: { seg_id: string; text: string }[];
  };
  jd: {
    title: string;
    category: string;
    level: string;
    hard_req: string[];
    raw: string;
  };
  tags: { category: string; experience_level: string; level: string };
  is_hard_negative: boolean;
  is_golden: boolean;
  run: ProfileMeta;
  runs: CaseRunDetail[];
}

export interface CasesResponse {
  cases: CaseMeta[];
}

/* ---------- 运行评测 job（与后端 src/server/evalJobs.ts 对应） ---------- */

export interface EvalProgress {
  phase: 'generating' | 'judging';
  completed: number;
  total: number;
  spentCny: number;
  remainingCny: number;
  hasFailure: boolean;
}

export interface EvalSummary {
  profiles: string[];
  caseCount: number;
  totalRuns: number;
  runs: number;
  judge: boolean;
  spentCny: number;
  genCostTotal: number;
  judgeCostTotal: number;
  noOutput: number;
  failures: number;
  reportPath: string | null;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
}

export interface EvalJobOpts {
  profiles: string[] | null;
  limit: number | null;
  runs: number;
  judge: boolean;
  budget: number;
  concurrency: number;
  dryRun: boolean;
}

export interface EvalJob {
  id: string;
  status: 'running' | 'done' | 'failed';
  startedAt: string;
  finishedAt: string | null;
  opts: EvalJobOpts;
  progress: EvalProgress | null;
  logs: string[];
  summary: EvalSummary | null;
  error: string | null;
  errorCode: string | null;
}

export interface StartEvalRequest {
  profiles?: string[] | null;
  limit?: number | null;
  runs?: number;
  judge?: boolean;
  budget?: number;
  concurrency?: number;
  dryRun?: boolean;
}

export interface EvalStatusResponse {
  job: EvalJob | null;
}

export interface EvalJobsResponse {
  jobs: EvalJob[];
}

/* ---------- JD 库（GET /api/jds） ---------- */
// 与 src/server/jdView.ts 一一对应。前端刻意不 import 后端的 schema：
// 这是浏览器产物，不该把整个后端类型图打进来。

export type JdLevelKey = 'intern' | 'junior' | 'senior';

export interface JdSourceStats {
  count: number;
  avgRawLength: number;
  avgHardReq: number;
  avgSoftReq: number;
  hardReqEmpty: number;
  missingHash: number;
  missingProvenance: number;
}

export interface JdCoverage {
  total: number;
  matrix: Record<string, Record<JdLevelKey, number>>;
  gaps: Array<{ category: string; level: JdLevelKey }>;
  duplicates: Array<{ hash: string; ids: string[] }>;
  bySource: { synthetic: JdSourceStats; real: JdSourceStats };
}

export interface JdListItem {
  id: string;
  title: string;
  company_type: string;
  category: string;
  level: JdLevelKey;
  source: 'synthetic' | 'real';
  provenance: string | null;
  collected_at: string | null;
  source_url: string | null;
  raw_length: number;
  hard_req: string[];
  soft_req: string[];
  excerpt: string;
  content_hash: string | null;
}

export interface JdView {
  total: number;
  coverage: JdCoverage;
  items: JdListItem[];
  labels: {
    categories: Record<string, string>;
    levels: Record<JdLevelKey, string>;
    categoryOrder: string[];
    levelOrder: JdLevelKey[];
  };
}
