/**
 * 评测结果聚合层 —— 给 Web 控制台喂数据。
 *
 * 它和 scripts/run-eval.ts 的关系：
 *   run-eval.ts 负责「跑」：真调模型、落盘、出 Markdown 报告。
 *   analyze.ts  负责「读」：把 data/real/ 里已经落盘的 runs JSONL 读回来，
 *   用同一套指标纯函数（metrics/ + stats/）重新算出结构化 JSON，供 HTTP 层渲染。
 *
 * 为什么不能把 run-eval.ts 里的汇总逻辑直接搬出来改成「一边跑一边出 JSON」：
 *   跑一次真实评测要花钱、花时间；而控制台要的是「秒开」。
 *   所以这里只读、只算，绝不发请求。改了指标口径，刷新页面就能看到新结论，
 *   不用重新花钱跑。
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadJsonCollection, readJsonl } from '../lib/jsonl.js';
import { buildDict } from '../metrics/entities.js';
import { auditSuggestions, unsourcedRate } from '../metrics/unsourced.js';
import { anchorCoverage, hardGateCoverage } from '../metrics/anchor.js';
import { passK, stabilityBreakdown, type RunOutcome } from '../metrics/passk.js';
import { mean, percentiles } from '../stats/rank.js';
import {
  compareRuns,
  partitionFindings,
  sliceDown,
  type CompareRow,
  type RunRecord,
  type SliceFinding,
} from '../stats/compare.js';
import { MODELS, PROVIDERS, type ModelSpec } from '../agent/catalog.js';
import type { Case, Jd, Resume, ResumeSegment, Suggestion } from '../schema/case.js';
import type { StepSpan } from '../schema/trace.js';

/** 项目根目录（src/server/ → 根目录） */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DATA_REAL = resolve(ROOT, 'data', 'real');
const DATA_DEMO = resolve(ROOT, 'data', 'demo');

/** runs JSONL 一行记录的形状（与 run-eval.ts 的落盘格式一致） */
interface RunRecordJson {
  run_id: string;
  case_id: string;
  run_index: number;
  model: string;
  prompt_version: string;
  error: string | null;
  input_tokens: number;
  output_tokens: number;
  cost_cny: number;
  latency_ms: number;
  invalid_anchors: string[];
  suggestions: Suggestion[];
}

interface JudgeRecordJson {
  run_id: string;
  case_id: string;
  judge_model: string;
  scores: number[];
  cost_cny: number;
  disagreements: number;
  correlation: number;
  error: string | null;
}

/** 单个 (run_id, case_id, run_index) 的指标计算结果 —— 与 run-eval.ts 同口径 */
interface ComputedRun {
  run_id: string;
  case_id: string;
  run_index: number;
  model: string;
  prompt_version: string;
  /** 是否产出了至少一条建议。无产出 = 跑废（模型报错 / 返回空），不计入质量均值 */
  hasOutput: boolean;
  passed: boolean;
  unsourcedRate: number;
  unsourcedExclExample: number;
  gateCoverage: number;
  anchorCoverage: number;
  execScore: number | null;
  costCny: number;
  latencyMs: number;
  tags: { category: string; experience_level: string; level: string };
}

export interface ProfileMeta {
  run_id: string;
  model: string;
  model_label: string;
  provider: string;
  prompt_version: string;
  /** 硅基流动是第三方转发，与原厂数字不可混比 */
  platform: string;
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

export interface AnalyzeResult {
  profiles: ProfileMeta[];
  leaderboard: LeaderboardRow[];
  judge: { model: string; label: string; disagreement_rate: number } | null;
  caseCount: number;
  dataset: { id: string; version: string; seed: number };
  generatedAt: string;
  /** 数据来源：真实评测 / 合成演示数据（data/real 为空时回退） */
  dataSource: 'real' | 'demo';
}

function readJsonlSafe<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  try {
    return readJsonl<T>(path);
  } catch {
    return [];
  }
}

/** 读某个目录下所有 runs*.jsonl（断点续跑会新开文件，必须读并集） */
function readRunsDir(dir: string): Map<string, RunRecordJson> {
  if (!existsSync(dir)) return new Map();
  const files = readdirSync(dir)
    .filter((f) => /^runs.*\.jsonl$/.test(f))
    .sort();
  const map = new Map<string, RunRecordJson>();
  for (const f of files) {
    for (const raw of readJsonlSafe<RunRecordJson>(resolve(dir, f))) {
      if (typeof raw?.run_id !== 'string' || typeof raw?.case_id !== 'string') continue;
      const key = `${raw.run_id}__${raw.case_id}__r${raw.run_index}`;
      map.set(key, raw);
    }
  }
  return map;
}

function readJudgeFile(path: string): Map<string, JudgeRecordJson> {
  const map = new Map<string, JudgeRecordJson>();
  for (const raw of readJsonlSafe<JudgeRecordJson>(path)) {
    if (typeof raw?.run_id !== 'string' || typeof raw?.case_id !== 'string') continue;
    map.set(`${raw.run_id}__${raw.case_id}`, raw);
  }
  return map;
}

function modelLabel(id: string): string {
  return MODELS[id]?.label ?? id;
}

function modelProvider(id: string): string {
  const spec: ModelSpec | undefined = MODELS[id];
  if (!spec) return 'unknown';
  return PROVIDERS[spec.provider]?.label ?? spec.provider;
}

function modelPlatform(id: string): string {
  const spec = MODELS[id];
  if (!spec) return 'unknown';
  if (spec.provider === 'siliconflow') return '硅基流动（转发）';
  if (spec.provider === 'deepseek') return 'DeepSeek 官方';
  if (spec.provider === 'zhipu') return '智谱 GLM 官方';
  return spec.provider;
}

/** 从 runs 数据里推出「有哪些档位（run_id）」，而不是依赖 catalog 的默认矩阵。 */
function profilesFromRuns(runs: Map<string, RunRecordJson>): ProfileMeta[] {
  const seen = new Map<string, RunRecordJson>();
  for (const r of runs.values()) if (!seen.has(r.run_id)) seen.set(r.run_id, r);
  return [...seen.entries()]
    .map(([run_id, r]) => ({
      run_id,
      model: r.model,
      model_label: modelLabel(r.model),
      provider: modelProvider(r.model),
      prompt_version: r.prompt_version,
      platform: modelPlatform(r.model),
    }))
    .sort((a, b) => a.run_id.localeCompare(b.run_id));
}

function computeCaseRuns(
  runs: Map<string, RunRecordJson>,
  cases: Map<string, Case>,
  resumes: Map<string, Resume>,
  jds: Map<string, Jd>,
  judge: Map<string, JudgeRecordJson>,
): ComputedRun[] {
  const out: ComputedRun[] = [];
  for (const rec of runs.values()) {
    const c = cases.get(rec.case_id);
    const resume = c ? resumes.get(c.resume_id) : undefined;
    const jd = c ? jds.get(c.jd_id) : undefined;
    if (!c || !resume || !jd) continue;

    const suggestions = rec.suggestions.map((s) => ({ ...s, run_id: rec.run_id }));
    const tags = { category: c.tags.category, experience_level: c.tags.experience_level, level: c.tags.level };

    // 无产出：单独处理，不计入质量均值（与 run-eval.ts 口径一致）。
    // 空结果混进质量均值会得到一个漂亮但错误的结论：「什么都产不出来的模型，无源实体率最低」。
    if (suggestions.length === 0) {
      out.push({
        run_id: rec.run_id,
        case_id: rec.case_id,
        run_index: rec.run_index,
        model: rec.model,
        prompt_version: rec.prompt_version,
        hasOutput: false,
        passed: false,
        unsourcedRate: 0,
        unsourcedExclExample: 0,
        gateCoverage: 0,
        anchorCoverage: 0,
        execScore: null,
        costCny: rec.cost_cny,
        latencyMs: rec.latency_ms,
        tags,
      });
      continue;
    }

    const dict = buildDict(resume, jd);
    const sourceText = [resume.segments.map((s) => s.text).join('\n'), jd.raw].join('\n');
    const unsourced = unsourcedRate(auditSuggestions(suggestions, sourceText, dict));
    const gates = hardGateCoverage(suggestions, jd.hard_req);
    const anchors = anchorCoverage(suggestions);
    const passed = unsourced.rate <= 0.15 && gates.rate >= 0.5;

    const jr = judge.get(`${rec.run_id}__${rec.case_id}`);
    const execScore = jr && jr.error === null && jr.scores.length > 0 ? mean(jr.scores) : null;

    out.push({
      run_id: rec.run_id,
      case_id: rec.case_id,
      run_index: rec.run_index,
      model: rec.model,
      prompt_version: rec.prompt_version,
      hasOutput: true,
      passed,
      unsourcedRate: unsourced.rate,
      unsourcedExclExample: unsourced.rateExcludingExamples,
      gateCoverage: gates.rate,
      anchorCoverage: anchors.rate,
      execScore,
      costCny: rec.cost_cny,
      latencyMs: rec.latency_ms,
      tags,
    });
  }
  return out;
}

function emptyLeaderboardRow(p: ProfileMeta): LeaderboardRow {
  return {
    run_id: p.run_id,
    model: p.model,
    model_label: p.model_label,
    provider: p.provider,
    prompt_version: p.prompt_version,
    total_runs: 0,
    output_count: 0,
    no_output_count: 0,
    output_rate: 0,
    unsourced_rate: 0,
    unsourced_excl_example: 0,
    gate_coverage: 0,
    anchor_coverage: 0,
    pass_rate: 0,
    pass_k: 0,
    exec_score: null,
    avg_cost_cny: 0,
    p95_latency_ms: 0,
    stability: { always: 0, never: 0, flaky: 0, flaky_rate: 0 },
  };
}

function buildLeaderboard(rows: ComputedRun[], profiles: ProfileMeta[]): LeaderboardRow[] {
  const byRun = new Map<string, ComputedRun[]>();
  for (const r of rows) {
    const arr = byRun.get(r.run_id) ?? [];
    arr.push(r);
    byRun.set(r.run_id, arr);
  }

  return profiles.map((p) => {
    const mine = byRun.get(p.run_id) ?? [];
    if (mine.length === 0) return emptyLeaderboardRow(p);

    const withOutput = mine.filter((r) => r.hasOutput);
    const noOutput = mine.length - withOutput.length;
    const total = mine.length;

    const avg = (f: (r: ComputedRun) => number, subset = withOutput) =>
      subset.length === 0 ? 0 : subset.reduce((s, r) => s + f(r), 0) / subset.length;

    // pass^k：k = 每 case 的最大重复次数（从数据里推）
    const maxRuns = Math.max(1, ...mine.map((r) => r.run_index + 1));
    const outcomes: RunOutcome[] = mine.map((r) => ({
      run_id: r.run_id,
      case_id: r.case_id,
      run_index: r.run_index,
      passed: r.passed,
    }));
    const pk = passK(outcomes, maxRuns);
    const stab = stabilityBreakdown(outcomes, maxRuns);

    return {
      run_id: p.run_id,
      model: p.model,
      model_label: p.model_label,
      provider: p.provider,
      prompt_version: p.prompt_version,
      total_runs: total,
      output_count: withOutput.length,
      no_output_count: noOutput,
      output_rate: total === 0 ? 0 : withOutput.length / total,
      unsourced_rate: avg((r) => r.unsourcedRate),
      unsourced_excl_example: avg((r) => r.unsourcedExclExample),
      gate_coverage: avg((r) => r.gateCoverage),
      anchor_coverage: avg((r) => r.anchorCoverage),
      pass_rate: total === 0 ? 0 : mine.filter((r) => r.passed).length / total,
      pass_k: pk.rate,
      exec_score: avg((r) => r.execScore ?? 0, withOutput.filter((r) => r.execScore !== null)),
      avg_cost_cny: avg((r) => r.costCny),
      p95_latency_ms: mine.length === 0 ? 0 : percentiles(mine.map((r) => r.latencyMs), [0.95])[0],
      stability: { always: stab.always, never: stab.never, flaky: stab.flaky, flaky_rate: stab.flakyRate },
    };
  });
}

export function runRecordsFor(rows: ComputedRun[], runId: string): RunRecord[] {
  return rows
    .filter((r) => r.run_id === runId)
    .map((r) => ({
      run_id: r.run_id,
      case_id: r.case_id,
      run_index: r.run_index,
      model: r.model,
      prompt_version: r.prompt_version,
      passed: r.passed,
      score: r.execScore ?? 0,
      cost_usd: r.costCny,
      latency_ms: r.latencyMs,
      unsourced_rate: r.unsourcedRate,
      anchor_coverage: r.anchorCoverage,
      tags: r.tags,
    }));
}

/** 缓存：数据文件没变就不重算（控制台要秒开）。同时把原始数据也缓存，供 case 详情复用。 */
let cache: {
  mtime: number;
  result: AnalyzeResult;
  rows: ComputedRun[];
  runs: Map<string, RunRecordJson>;
  cases: Map<string, Case>;
  resumes: Map<string, Resume>;
  jds: Map<string, Jd>;
  judge: Map<string, JudgeRecordJson>;
  dataSource: 'real' | 'demo';
} | null = null;

/** 显式失效缓存（评测完成、数据变化后调用，兜底 mtime 判断） */
export function invalidateCache(): void {
  cache = null;
}

function dataMtime(): number {
  let m = 0;
  const dirs = [
    DATA_REAL,
    DATA_DEMO,
    resolve(ROOT, 'data', 'cases'),
    resolve(ROOT, 'data', 'jd'),
    resolve(ROOT, 'data', 'resumes'),
  ];
  for (const d of dirs) {
    if (!existsSync(d)) continue;
    try {
      m = Math.max(m, statSync(d).mtimeMs);
      for (const f of readdirSync(d)) {
        try {
          m = Math.max(m, statSync(resolve(d, f)).mtimeMs);
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* ignore */
    }
  }
  return m;
}

export function analyze(): { result: AnalyzeResult; rows: ComputedRun[] } {
  const mtime = dataMtime();
  if (cache && cache.mtime === mtime) return { result: cache.result, rows: cache.rows };

  // 优先读真实评测数据；clone 下来还没跑过时，回退到合成演示数据（data/demo）。
  let runs = readRunsDir(DATA_REAL);
  let judge = readJudgeFile(resolve(DATA_REAL, 'judge.jsonl'));
  let dataSource: 'real' | 'demo' = 'real';
  if (runs.size === 0) {
    runs = readRunsDir(DATA_DEMO);
    judge = readJudgeFile(resolve(DATA_DEMO, 'judge.jsonl'));
    dataSource = 'demo';
  }

  const cases = new Map<string, Case>();
  for (const c of readJsonlSafe<Case>(resolve(ROOT, 'data', 'cases', 'cases.jsonl'))) cases.set(c.id, c);
  const resumes = new Map(loadJsonCollection<Resume>(resolve(ROOT, 'data', 'resumes')).map((r) => [r.id, r]));
  const jds = new Map(loadJsonCollection<Jd>(resolve(ROOT, 'data', 'jd')).map((j) => [j.id, j]));

  const profiles = profilesFromRuns(runs);
  const rows = computeCaseRuns(runs, cases, resumes, jds, judge);

  // 裁判元信息
  let judgeMeta: AnalyzeResult['judge'] = null;
  const anyJudge = [...judge.values()].find((j) => j.error === null);
  if (anyJudge) {
    let disagree = 0;
    let total = 0;
    for (const j of judge.values()) {
      if (j.error === null) {
        disagree += Math.max(0, j.disagreements);
        total += j.scores.length * 2; // 正反序各一次
      }
    }
    judgeMeta = {
      model: anyJudge.judge_model,
      label: modelLabel(anyJudge.judge_model),
      disagreement_rate: total === 0 ? 0 : disagree / total,
    };
  }

  let dataset: AnalyzeResult['dataset'] = { id: 'offerlens-resume-jd', version: 'ds-v1', seed: 20261004 };
  const datasetPath = resolve(ROOT, 'data', 'cases', 'dataset.json');
  if (existsSync(datasetPath)) {
    try {
      dataset = JSON.parse(readFileSync(datasetPath, 'utf8')) as AnalyzeResult['dataset'];
    } catch {
      /* ignore */
    }
  }

  const result: AnalyzeResult = {
    profiles,
    leaderboard: buildLeaderboard(rows, profiles),
    judge: judgeMeta,
    caseCount: cases.size,
    dataset,
    generatedAt: new Date().toISOString(),
    dataSource,
  };

  cache = { mtime, result, rows, runs, cases, resumes, jds, judge, dataSource };
  return { result, rows };
}

/** 对比两个档位：矩阵 + 切片下钻。返回结构化 JSON。 */
export interface CompareResult {
  base: ProfileMeta;
  cand: ProfileMeta;
  matrix: CompareRow;
  slice: {
    quality: SliceFinding[];
    resource: SliceFinding[];
    resourceCollapsed: number;
  };
  /** 跨平台提示（硅基流动 vs 原厂数字不可混比） */
  crossPlatform: boolean;
}

export function compare(baseRunId: string, candRunId: string): CompareResult | { error: string } {
  const { result, rows } = analyze();
  const base = result.profiles.find((p) => p.run_id === baseRunId);
  const cand = result.profiles.find((p) => p.run_id === candRunId);
  if (!base || !cand) return { error: `档位不存在：${!base ? baseRunId : candRunId}` };

  const matrix = compareRuns(runRecordsFor(rows, baseRunId), runRecordsFor(rows, candRunId));
  const findings = sliceDown(runRecordsFor(rows, baseRunId), runRecordsFor(rows, candRunId), ['experience_level', 'category']);
  const slice = partitionFindings(findings);

  return { base, cand, matrix, slice, crossPlatform: base.platform !== cand.platform };
}

/* ------------------------------------------------------------------ */
/* Case 详情 + trace 瀑布图                                            */
/* ------------------------------------------------------------------ */

/** 一次运行的详情（含 trace spans，供瀑布图） */
export interface CaseRunDetail {
  run_index: number;
  error: string | null;
  input_tokens: number;
  output_tokens: number;
  cost_cny: number;
  latency_ms: number;
  invalid_anchors: string[];
  suggestions: Suggestion[];
  spans: StepSpan[];
}

/** 单个 case 的元信息（供 case 选择器下拉） */
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
    segments: ResumeSegment[];
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

function ensureLoaded() {
  if (!cache) analyze();
  return cache!;
}

/** 读某个 (run, case, run_index) 的 trace spans。真实数据带 __rN 后缀，demo 不带。 */
function readTraceSpans(runId: string, caseId: string, runIndex: number, source: 'real' | 'demo'): StepSpan[] {
  const dir = resolve(source === 'real' ? DATA_REAL : DATA_DEMO, 'traces');
  const candidates = [
    resolve(dir, `${runId}__${caseId}__r${runIndex}.jsonl`),
    resolve(dir, `${runId}__${caseId}.jsonl`),
  ];
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    const spans = readJsonlSafe<StepSpan>(p);
    if (spans.length > 0) return spans;
  }
  return [];
}

/** 列出评测集里所有 case（含岗位/画像标签），供详情页选择。 */
export function listCases(): CaseMeta[] {
  const { cases, resumes, jds } = ensureLoaded();
  const out: CaseMeta[] = [];
  for (const c of cases.values()) {
    const resume = resumes.get(c.resume_id);
    const jd = jds.get(c.jd_id);
    out.push({
      case_id: c.id,
      tags: {
        category: c.tags.category,
        experience_level: c.tags.experience_level,
        level: c.tags.level,
      },
      resume_headline: resume?.headline ?? '',
      resume_anon_id: resume?.anon_id ?? '',
      jd_title: jd?.title ?? '',
      is_hard_negative: c.is_hard_negative,
      is_golden: c.is_golden,
    });
  }
  return out.sort((a, b) => a.case_id.localeCompare(b.case_id));
}

/** 某个 (档位, case) 的完整详情：简历/JD 摘要 + 各次重复的产出与 trace。 */
export function caseDetail(runId: string, caseId: string): CaseDetailResult | { error: string } {
  const { result, runs, cases, resumes, jds, dataSource } = ensureLoaded();

  const profile = result.profiles.find((p) => p.run_id === runId);
  if (!profile) return { error: `档位不存在：${runId}` };

  const c = cases.get(caseId);
  if (!c) return { error: `case 不存在：${caseId}` };
  const resume = resumes.get(c.resume_id);
  const jd = jds.get(c.jd_id);
  if (!resume || !jd) return { error: `case ${caseId} 关联的简历或 JD 缺失` };

  const records = [...runs.values()]
    .filter((r) => r.run_id === runId && r.case_id === caseId)
    .sort((a, b) => a.run_index - b.run_index);

  const detailRuns: CaseRunDetail[] = records.map((rec) => ({
    run_index: rec.run_index,
    error: rec.error,
    input_tokens: rec.input_tokens,
    output_tokens: rec.output_tokens,
    cost_cny: rec.cost_cny,
    latency_ms: rec.latency_ms,
    invalid_anchors: rec.invalid_anchors,
    suggestions: rec.suggestions,
    spans: readTraceSpans(runId, caseId, rec.run_index, dataSource),
  }));

  return {
    caseId,
    resume: {
      anon_id: resume.anon_id,
      headline: resume.headline,
      experience_level: resume.experience_level,
      segments: resume.segments,
    },
    jd: {
      title: jd.title,
      category: jd.category,
      level: jd.level,
      hard_req: jd.hard_req,
      raw: jd.raw,
    },
    tags: { category: c.tags.category, experience_level: c.tags.experience_level, level: c.tags.level },
    is_hard_negative: c.is_hard_negative,
    is_golden: c.is_golden,
    run: profile,
    runs: detailRuns,
  };
}
