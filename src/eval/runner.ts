/**
 * 真实模型评测运行器 —— 可复用的核心（CLI 与 Web 控制台共用同一份逻辑）。
 *
 * 从 `scripts/run-eval.ts` 抽取而来：原来的 `main()` 把所有逻辑揉在一个函数里、
 * 用 `console.log` / `process.stdout.write` 直接往终端写。要把它搬进 Web 控制台，
 * 唯一的改动点就是「输出」——所以这里把输出抽象成 `emit` 事件回调：
 *   - `{ type: 'log', line }`      一行日志（CLI 转成 console 输出，Web 收进日志面板）
 *   - `{ type: 'progress', ... }`  结构化进度（驱动 Web 进度条；CLI 转成 \r 刷新）
 *   - `{ type: 'done', summary }`  完成（含成本/无产出/失败/报告路径汇总）
 *
 * 核心计算（任务组装、并发池、断点续跑、指标、裁判、对比、落库、报告）**一行没改**，
 * 只把「往哪输出」换成了「把结果发给谁」。缺 API key 等前置失败改为抛 `EvalError`，
 * 让 Web 端能用结构化错误码返回 4xx，而不是让用户去翻日志。
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { initDb } from '../db/init.js';
import { loadEnv } from '../lib/env.js';
import { loadJsonCollection, readJsonl } from '../lib/jsonl.js';
import { budgetExceeded, BudgetTracker } from '../lib/budget.js';
import { buildDict } from '../metrics/entities.js';
import { auditSuggestions, unsourcedRate } from '../metrics/unsourced.js';
import { anchorCoverage, hardGateCoverage } from '../metrics/anchor.js';
import { judgeHumanAgreement } from '../metrics/judge.js';
import { computeStepMetrics } from '../metrics/steps.js';
import { mean } from '../stats/rank.js';
import { passK, stabilityBreakdown, type RunOutcome } from '../metrics/passk.js';
import {
  compareRuns,
  compareToMarkdown,
  partitionFindings,
  sliceDown,
  sliceFindingsToMarkdown,
  type RunRecord,
} from '../stats/compare.js';
import { OfferAgent } from '../agent/offerAgent.js';
import { judgeSuggestions } from '../agent/llmJudge.js';
import {
  baselineRunId,
  defaultJudge,
  defaultProfiles,
  formatPrice,
  PROVIDERS,
  resolveApiKey,
  type EvalProfile,
} from '../agent/catalog.js';
import { renderResume } from '../agent/prompts.js';
import type { Jd, Resume, Suggestion } from '../schema/case.js';
import type { StepSpan } from '../schema/trace.js';
import { buildCases } from '../../scripts/build-cases.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = resolve(ROOT, 'data/real');

/* ------------------------------------------------------------------ */
/* 类型                                                                */
/* ------------------------------------------------------------------ */

export interface EvalOptions {
  /** 只跑指定档位（run_id 列表）；null/缺省 = 全部默认档位 */
  profiles?: string[] | null;
  /** 只跑前 N 组 case；null = 全部 */
  limit?: number | null;
  /** 每组重复次数（pass^k 需要 ≥ 2） */
  runs?: number;
  /** 是否跑 LLM 裁判（可执行性分） */
  judge?: boolean;
  /** 预算硬上限（元） */
  budget?: number;
  /** 并发数 */
  concurrency?: number;
  /** 只打印第一条 prompt，不发请求 */
  dryRun?: boolean;
  /** 只按已落盘数据重新汇总 + 出报告，不产生新费用 */
  reportOnly?: boolean;
}

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
  /** 本次实际派发的任务数（report-only 或 dry-run 时为 0） */
  totalRuns: number;
  runs: number;
  judge: boolean;
  /** 本次进程新花的钱（续跑时为 0 属正常） */
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

export type EvalEvent =
  | { type: 'log'; line: string }
  | { type: 'progress'; progress: EvalProgress }
  | { type: 'done'; summary: EvalSummary };

export type Emit = (event: EvalEvent) => void;

/** 评测前置失败（缺 key / 档位不匹配），Web 端据此返回结构化 4xx */
export class EvalError extends Error {
  constructor(
    message: string,
    public code: 'missing_key' | 'no_profiles' | 'internal',
  ) {
    super(message);
    this.name = 'EvalError';
  }
}

/* ------------------------------------------------------------------ */
/* 落盘形状                                                            */
/* ------------------------------------------------------------------ */

interface CaseRun {
  profile: EvalProfile;
  case_id: string;
  run_index: number;
  suggestions: Suggestion[];
  spans: StepSpan[];
  inputTokens: number;
  outputTokens: number;
  costCny: number;
  latencyMs: number;
  error: string | null;
  invalidAnchors: string[];
  passed: boolean;
  unsourced: number;
  unsourcedExclExample: number;
  exampleLocated: number;
  gateCoverage: number;
  anchorCoverage: number;
  execScore: number | null;
}

interface RunRecordJson {
  key: string;
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

/** 汇总 data/real 下所有 runs-*.jsonl（断点续跑每启动一次新开一个文件，必须读并集） */
function loadAllRunRecords(): RunRecordJson[] {
  if (!existsSync(OUT)) return [];
  const files = readdirSync(OUT)
    .filter((f) => /^runs-.*\.jsonl$/.test(f))
    .sort();
  const map = new Map<string, RunRecordJson>();
  for (const f of files) {
    for (const raw of readJsonlSafe(resolve(OUT, f))) {
      const r = raw as Partial<RunRecordJson>;
      if (typeof r?.run_id !== 'string' || typeof r?.case_id !== 'string') continue;
      const key = `${r.run_id}__${r.case_id}__r${r.run_index}`;
      map.set(key, { ...(r as Omit<RunRecordJson, 'key'>), key });
    }
  }
  return [...map.values()];
}

const JUDGE_PATH = resolve(OUT, 'judge.jsonl');

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

function loadJudgeRecords(): Map<string, JudgeRecordJson> {
  const map = new Map<string, JudgeRecordJson>();
  for (const raw of readJsonlSafe(JUDGE_PATH)) {
    const r = raw as Partial<JudgeRecordJson>;
    if (typeof r?.run_id !== 'string' || typeof r?.case_id !== 'string') continue;
    map.set(`${r.run_id}__${r.case_id}`, r as JudgeRecordJson);
  }
  return map;
}

function tracePath(runId: string, caseId: string, runIndex: number): string {
  return resolve(OUT, 'traces', `${runId}__${caseId}__r${runIndex}.jsonl`);
}

async function pool<T>(
  items: readonly T[],
  size: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(size, items.length)) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      await worker(items[i], i);
    }
  });
  await Promise.all(runners);
}

/* ================================================================== */

export async function runEval(opts: EvalOptions, emit: Emit): Promise<EvalSummary> {
  const runs = opts.runs ?? 3;
  const judge = opts.judge ?? true;
  const budgetLimit = opts.budget ?? 100;
  const concurrency = opts.concurrency ?? 4;
  const limit = opts.limit ?? null;
  const dryRun = opts.dryRun ?? false;
  const reportOnly = opts.reportOnly ?? false;

  if (!Number.isInteger(runs) || runs < 1) throw new EvalError(`runs 需要正整数，收到 ${runs}`, 'internal');
  if (!Number.isFinite(budgetLimit) || budgetLimit < 0) throw new EvalError(`budget 需要非负数，收到 ${budgetLimit}`, 'internal');
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new EvalError(`concurrency 需要正整数，收到 ${concurrency}`, 'internal');
  if (limit !== null && (!Number.isInteger(limit) || limit < 1)) throw new EvalError(`limit 需要正整数，收到 ${limit}`, 'internal');

  const startedAt = new Date().toISOString();
  const log = (msg: string) => emit({ type: 'log', line: msg });

  /* ---------- 加载凭证 ---------- */
  const envResult = loadEnv(resolve(ROOT, '.env'));
  const wanted = opts.profiles ?? null;
  const profiles = wanted
    ? defaultProfiles().filter((p) => wanted.includes(p.run_id))
    : defaultProfiles();
  if (profiles.length === 0) {
    throw new EvalError(
      `没有匹配的档位。可选：${defaultProfiles().map((p) => p.run_id).join(' / ')}`,
      'no_profiles',
    );
  }

  const judgeSel = defaultJudge();

  log('=== OfferLens 真实模型评测 ===\n');
  log(`.env：${envResult.found ? `已加载（${envResult.loaded.join(', ') || '无新键'}）` : '不存在'}`);
  log(`预算上限：¥${budgetLimit}　并发：${concurrency}　每档重复：${runs} 次`);
  log('');
  log('评测档位（生成侧）：');
  for (const p of profiles) {
    const { missing } = resolveApiKey(p.model);
    log(
      `  ${p.run_id.padEnd(22)} ${p.model.label.padEnd(24)} ${p.prompt_version.padEnd(12)} ` +
        `${formatPrice(p.model).padEnd(34)} ${missing ? '❌ 缺 key' : '✅'}`,
    );
  }
  log('裁判模型（需与生成侧不同族）：');
  {
    const { missing } = resolveApiKey(judgeSel.model);
    log(
      `  ${judgeSel.model.label.padEnd(24)} ${formatPrice(judgeSel.model).padEnd(34)} ` +
        `${missing ? '❌ 缺 key' : '✅'}` +
        (judgeSel.crossFamily ? '  ✅ 跨族' : '  ⚠️ 与生成侧同族，可执行性结论需谨慎'),
    );
  }

  const needed = new Set(profiles.map((p) => p.model.provider));
  if (judge) needed.add(judgeSel.model.provider);
  const missingProviders = [...needed].filter((id) => {
    const cfg = PROVIDERS[id];
    if (cfg.apiKeyEnv === null) return false;
    const anyModel = [...profiles.map((p) => p.model), judgeSel.model].find((m) => m.provider === id);
    return anyModel ? resolveApiKey(anyModel).missing : false;
  });

  if (missingProviders.length > 0 && !dryRun) {
    const lines = missingProviders.map((id) => {
      const cfg = PROVIDERS[id];
      return `${cfg.label}（环境变量 ${cfg.apiKeyEnv}，注册地址 ${cfg.signupUrl}）`;
    });
    throw new EvalError(
      `缺少 API Key：${lines.join('；')}。请写入 ${resolve(ROOT, '.env')}`,
      'missing_key',
    );
  }

  /* ---------- 数据 ---------- */
  const jds = loadJsonCollection<Jd>(resolve(ROOT, 'data/jd'));
  const resumes = loadJsonCollection<Resume>(resolve(ROOT, 'data/resumes'));
  const resumeById = new Map(resumes.map((r) => [r.id, r]));
  const jdById = new Map(jds.map((j) => [j.id, j]));

  const { dataset, cases: allCases } = buildCases(resumes, jds, { seed: 20261004 });
  const cases = limit === null ? allCases : allCases.slice(0, limit);

  /* ---------- dry-run：打印 prompt 就退出 ---------- */
  if (dryRun) {
    const c = cases[0];
    const resume = resumeById.get(c.resume_id);
    const jd = jdById.get(c.jd_id);
    if (!resume || !jd) throw new EvalError('dry-run 用的 case 数据缺失', 'internal');
    log('\n=== --dry-run：以下内容会发给模型，但**不会真的发** ===\n');
    log(`--- case: ${c.id}（${resume.anon_id} × ${jd.title}）---\n`);
    log('【Step 2 的输入 · 简历渲染（段 ID 是锚点的基础）】\n');
    log(renderResume(resume));
    log('\n【Step 2 的输入 · JD 原文】\n');
    log(jd.raw);
    log('\n=== 结束。确认无误后去掉 --dry-run 即开始真实调用 ===');

    const summary: EvalSummary = {
      profiles: profiles.map((p) => p.run_id),
      caseCount: cases.length,
      totalRuns: 0,
      runs,
      judge,
      spentCny: 0,
      genCostTotal: 0,
      judgeCostTotal: 0,
      noOutput: 0,
      failures: 0,
      reportPath: null,
      startedAt,
      finishedAt: new Date().toISOString(),
      durationMs: 0,
    };
    emit({ type: 'done', summary });
    return summary;
  }

  mkdirSync(resolve(OUT, 'traces'), { recursive: true });
  mkdirSync(resolve(ROOT, 'reports'), { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const runsPath = resolve(OUT, `runs-${stamp}.jsonl`);

  const budget = new BudgetTracker(budgetLimit);
  const results: CaseRun[] = [];
  const failures: Array<{ key: string; error: string }> = [];

  // 断点续跑：只把**成功**记录算作已完成，失败记录要重试（否则网络抖动会被固化成"模型跑不了"）。
  const doneKeys = new Set(loadAllRunRecords().filter((r) => !r.error).map((r) => r.key));
  let skipped = 0;

  /* ---------- 组装任务列表 ---------- */
  interface Task {
    profile: EvalProfile;
    caseId: string;
    runIndex: number;
  }
  const tasks: Task[] = [];
  for (const profile of profiles) {
    for (const c of cases) {
      for (let r = 0; r < runs; r++) {
        tasks.push({ profile, caseId: c.id, runIndex: r });
      }
    }
  }

  log(`\n共 ${tasks.length} 次运行（${profiles.length} 档位 × ${cases.length} 组 × ${runs} 次）`);
  log(`预计模型调用：约 ${tasks.length * 3 + (judge ? cases.length * profiles.length * 2 : 0)} 次\n`);

  let completed = 0;
  let stopped = false;

  if (reportOnly) {
    tasks.length = 0;
    log('（--report-only：跳过生成阶段，直接基于 data/real/ 已落盘数据重新汇总，不产生新费用）\n');
  }

  await pool(tasks, concurrency, async (task) => {
    if (stopped) return;
    if (budgetExceeded(budget)) {
      stopped = true;
      return;
    }

    const { profile, caseId, runIndex } = task;
    const c = cases.find((x) => x.id === caseId);
    const resume = resumeById.get(c?.resume_id ?? '');
    const jd = jdById.get(c?.jd_id ?? '');
    if (!c || !resume || !jd) return;

    const key = `${profile.run_id}__${caseId}__r${runIndex}`;
    const tPath = tracePath(profile.run_id, caseId, runIndex);

    if (doneKeys.has(key)) {
      skipped++;
      completed++;
      return;
    }

    const agent = new OfferAgent(profile.model, profile.prompt_version);
    let res;
    try {
      res = await agent.run(c, resume, jd, runIndex);
    } catch (err) {
      failures.push({ key, error: err instanceof Error ? err.message : String(err) });
      return;
    }

    budget.add(res.costCny);
    writeFileSync(tPath, res.spans.map((s) => JSON.stringify(s)).join('\n') + '\n', 'utf8');

    appendFileSync(
      runsPath,
      JSON.stringify({
        run_id: profile.run_id,
        case_id: caseId,
        run_index: runIndex,
        model: profile.model.id,
        prompt_version: profile.prompt_version,
        error: res.error,
        input_tokens: res.inputTokens,
        output_tokens: res.outputTokens,
        cost_cny: Number(res.costCny.toFixed(6)),
        latency_ms: res.latencyMs,
        invalid_anchors: res.invalidAnchors,
        suggestions: res.suggestions,
      }) + '\n',
      'utf8',
    );

    completed++;
    if (completed % 10 === 0 || completed === tasks.length) {
      emit({
        type: 'progress',
        progress: {
          phase: 'generating',
          completed,
          total: tasks.length,
          spentCny: budget.spentCny,
          remainingCny: budget.remainingCny(),
          hasFailure: !!res.error,
        },
      });
    }
  });

  if (budgetExceeded(budget)) {
    log(`\n⚠️ 已触及预算上限 ¥${budgetLimit}，提前停止。已完成的 ${completed} 次结果仍然有效。`);
  }
  if (failures.length > 0) {
    log(`\n⚠️ ${failures.length} 次运行失败（前 3 条）：`);
    for (const f of failures.slice(0, 3)) log(`   ${f.key}：${f.error.slice(0, 160)}`);
  }

  /* ---------- 汇总 ---------- */
  log('\n=== 一、逐组指标 ===\n');
  if (skipped > 0) log(`（本次跳过 ${skipped} 次已完成的运行，其记录从历史文件一并读入）\n`);
  const labelOf = new Map<string, { resume: Resume; jd: Jd }>();
  for (const c of cases) {
    const r = resumeById.get(c.resume_id);
    const j = jdById.get(c.jd_id);
    if (r && j) labelOf.set(c.id, { resume: r, jd: j });
  }

  // 无产出的运行必须单独拎出来，不能混进质量均值（否则"什么都产不出来的模型"无源实体率最低）。
  const noOutputRuns: Array<{ run_id: string; case_id: string; run_index: number }> = [];
  const noOutputCount = new Map<string, number>();

  for (const rec of loadAllRunRecords()) {
    const ctx = labelOf.get(rec.case_id);
    const c = cases.find((x) => x.id === rec.case_id);
    if (!ctx || !c) continue;
    const profile = profiles.find((p) => p.run_id === rec.run_id);
    if (!profile) continue;

    if (rec.suggestions.length === 0) {
      noOutputCount.set(rec.run_id, (noOutputCount.get(rec.run_id) ?? 0) + 1);
      noOutputRuns.push({ run_id: rec.run_id, case_id: rec.case_id, run_index: rec.run_index });
      continue;
    }

    const dict = buildDict(ctx.resume, ctx.jd);
    const sourceText = [ctx.resume.segments.map((s) => s.text).join('\n'), ctx.jd.raw].join('\n');
    const suggestions = rec.suggestions.map((s) => ({ ...s, run_id: rec.run_id }));
    const unsourced = unsourcedRate(auditSuggestions(suggestions, sourceText, dict));
    const gates = hardGateCoverage(suggestions, ctx.jd.hard_req);
    const anchors = anchorCoverage(suggestions);
    const passed = unsourced.rate <= 0.15 && gates.rate >= 0.5;

    results.push({
      profile,
      case_id: rec.case_id,
      run_index: rec.run_index,
      suggestions,
      spans: [],
      inputTokens: rec.input_tokens,
      outputTokens: rec.output_tokens,
      costCny: rec.cost_cny,
      latencyMs: rec.latency_ms,
      error: rec.error,
      invalidAnchors: rec.invalid_anchors ?? [],
      passed,
      unsourced: unsourced.rate,
      unsourcedExclExample: unsourced.rateExcludingExamples,
      exampleLocated: unsourced.exampleLocated,
      gateCoverage: gates.rate,
      anchorCoverage: anchors.rate,
      execScore: null,
    });
  }

  log(
    '档位'.padEnd(24) + '有产出  无产出  产出率  无源实体率(严)  门槛覆盖  锚点覆盖  达标率(含无产出)',
  );
  for (const profile of profiles) {
    const mine = results.filter((r) => r.profile.run_id === profile.run_id);
    const missed = noOutputCount.get(profile.run_id) ?? 0;
    const total = mine.length + missed;
    if (total === 0) {
      log(`${profile.run_id.padEnd(24)}(无数据)`);
      continue;
    }
    const avg = (f: (r: CaseRun) => number) => mine.reduce((s, r) => s + f(r), 0) / mine.length;
    log(
      profile.run_id.padEnd(24) +
        String(mine.length).padEnd(8) +
        String(missed).padEnd(8) +
        (mine.length / total).toFixed(3).padEnd(8) +
        avg((r) => r.unsourced).toFixed(3).padEnd(16) +
        avg((r) => r.gateCoverage).toFixed(3).padEnd(10) +
        avg((r) => r.anchorCoverage).toFixed(3).padEnd(10) +
        (mine.filter((r) => r.passed).length / total).toFixed(3),
    );
  }
  if (noOutputRuns.length > 0) {
    log(
      `\n⚠️ 口径说明（这一条很关键，别看错）：${noOutputRuns.length} 次运行**没产出任何建议**（模型报错或返回空）。\n` +
        `   它们计入「达标率(含无产出)」的分母（记为未达标）、计入 pass^k，\n` +
        `   但**不参与**无源实体率/门槛覆盖/锚点覆盖的均值 —— 没产出就谈不上产出质量。\n` +
        `   若把空结果混进质量均值，会得到一个漂亮但完全错误的结论：\n` +
        `   「什么都产不出来的模型，无源实体率最低」。`,
    );
  }
  const totalExamples = results.reduce((s, r) => s + r.exampleLocated, 0);
  if (totalExamples > 0) {
    log(
      `\n口径说明：严口径把"示例/模板片段"（例如「…每 15s 发心跳…」）里的实体也算无源，` +
        `共 ${totalExamples} 个实体落在示例片段内。\n` +
        `          扣示例后那一列只统计**对简历的断言**。两个口径都报，因为哪个更对取决于问的是什么。`,
    );
  }

  const totalInvalid = results.reduce((s, r) => s + r.invalidAnchors.length, 0);
  if (totalInvalid > 0) {
    log(
      `\n⚠️ 模型回填了 ${totalInvalid} 个**不存在的段 ID**（已置空，未污染锚点覆盖率）。` +
        `这是"假装有出处"，值得单独看一眼模型都编了什么。`,
    );
  }
  log(`\n判定规则：无源实体率 ≤ 15% 且硬门槛覆盖 ≥ 50% 记为达标（与 demo 同一口径）。`);

  /* ---------- stability ---------- */
  log('\n=== 二、稳定性（pass^k）===\n');
  const outcomes: RunOutcome[] = [
    ...results.map((r) => ({
      run_id: r.profile.run_id,
      case_id: r.case_id,
      run_index: r.run_index,
      passed: r.passed,
    })),
    ...noOutputRuns.map((o) => ({ ...o, passed: false })),
  ];
  for (const profile of profiles) {
    const subset = outcomes.filter((o) => o.run_id === profile.run_id);
    if (subset.length === 0) continue;
    const pk = passK(subset, runs);
    const stab = stabilityBreakdown(subset, runs);
    log(
      `${profile.run_id.padEnd(24)} pass^${runs} = ${pk.rate.toFixed(3)}` +
        `（${pk.passedCases}/${pk.eligibleCases}）· 全过 ${stab.always} / 时好时坏 ${stab.flaky} / 全挂 ${stab.never}` +
        ` · 不稳定率 ${(stab.flakyRate * 100).toFixed(0)}%`,
    );
  }

  /* ---------- LLM 裁判 ---------- */
  const judgeDiag: string[] = [];
  let judgeCostTotal = 0;
  if (judge) {
    log('\n=== 三、LLM 裁判：给 run_index=0 的建议打可执行性分 ===\n');
    const scoreByKey = new Map<string, number[]>();
    let allDisagreements = 0;
    let judged = 0;
    let judgedCached = 0;
    let judgeFailed = 0;
    let corrSum = 0;
    let suspiciousCount = 0;

    const judgeCache = loadJudgeRecords();
    const judgeTasks = results.filter((r) => r.run_index === 0);
    let jd0 = 0;
    await pool(judgeTasks, Math.max(1, Math.floor(concurrency / 2)), async (r) => {
      const key = `${r.profile.run_id}__${r.case_id}`;

      const cached = judgeCache.get(key);
      if (cached && cached.error === null) {
        r.execScore = cached.scores.length > 0 ? mean(cached.scores) : null;
        scoreByKey.set(key, cached.scores);
        allDisagreements += Math.max(0, cached.disagreements);
        corrSum += cached.correlation;
        if (Math.abs(cached.correlation) > 0.5) suspiciousCount++;
        judged++;
        judgedCached++;
        judgeCostTotal += cached.cost_cny;
        return;
      }

      if (budgetExceeded(budget)) return;
      const jr = await judgeSuggestions(judgeSel.model, r.suggestions.map((s) => s.text));
      if (jr.error) {
        judgeFailed++;
        return;
      }
      budget.add(jr.stats.costCny);
      judgeCostTotal += jr.stats.costCny;
      r.execScore = jr.scores.length > 0 ? mean(jr.scores) : null;
      scoreByKey.set(key, jr.scores);
      allDisagreements += Math.max(0, jr.disagreements);
      corrSum += jr.lengthBias.correlation;
      if (jr.lengthBias.suspicious) suspiciousCount++;
      appendFileSync(
        JUDGE_PATH,
        JSON.stringify({
          run_id: r.profile.run_id,
          case_id: r.case_id,
          judge_model: judgeSel.model.id,
          scores: jr.scores,
          cost_cny: Number(jr.stats.costCny.toFixed(6)),
          disagreements: jr.disagreements,
          correlation: jr.lengthBias.correlation,
          error: null,
        }) + '\n',
        'utf8',
      );
      judged++;
      jd0++;
      if (jd0 % 5 === 0) {
        emit({
          type: 'progress',
          progress: {
            phase: 'judging',
            completed: jd0,
            total: judgeTasks.length,
            spentCny: budget.spentCny,
            remainingCny: budget.remainingCny(),
            hasFailure: false,
          },
        });
      }
    });

    log(`裁判 ${judged} 组（其中 ${judgedCached} 组复用了历史结果、未重复付费），失败 ${judgeFailed} 组`);
    if (judged > 0) {
      log(
        `位置偏见：正反序打分不一致 ${allDisagreements} 条` +
          `（占 ${((allDisagreements / Math.max(1, judged * 4)) * 100).toFixed(1)}%）` +
          `${allDisagreements === 0 ? ' —— 在这批数据上位置偏见不明显' : ' —— 说明打分对顺序敏感，值得进一步查'}`,
      );
      const avgCorr = corrSum / judged;
      log(
        `长度偏见：建议长度与得分的平均秩相关 ${avgCorr.toFixed(2)}` +
          `${avgCorr > 0.5 ? ' ⚠️ 超过 0.5，judge 在按长度打分，结论不可直接用' : '（< 0.5，未发现明显长度偏见）'}` +
          `${suspiciousCount > 0 ? `，另有 ${suspiciousCount} 组单项超标` : ''}`,
      );
    }
    judgeDiag.push(`裁判模型：${judgeSel.model.label}`, `跨族：${judgeSel.crossFamily ? '是' : '否（同族，可执行性结论需谨慎）'}`);

    /* ---------- 与人工标注的一致率 ---------- */
    const goldPath = resolve(ROOT, 'data/gold/labels.jsonl');
    if (existsSync(goldPath)) {
      const golds = readJsonlSafe(goldPath) as Array<{
        case_id: string;
        suggestion_scores: Record<string, number>;
      }>;
      const judgeScores: number[] = [];
      const humanScores: number[] = [];
      for (const r of results.filter((x) => x.run_index === 0)) {
        const gold = golds.find((g) => g.case_id === r.case_id);
        if (!gold) continue;
        const js = scoreByKey.get(`${r.profile.run_id}__${r.case_id}`);
        if (!js) continue;
        r.suggestions.forEach((s, i) => {
          const human = gold.suggestion_scores[s.id];
          if (typeof human === 'number' && typeof js[i] === 'number') {
            judgeScores.push(js[i]);
            humanScores.push(human);
          }
        });
      }
      if (judgeScores.length >= 5) {
        const agree = judgeHumanAgreement(judgeScores, humanScores);
        log(
          `\n与人工标注一致率（n=${agree.n}）：完全一致 ${(agree.exact * 100).toFixed(1)}%　` +
            `相差 ≤1 分 ${(agree.within1 * 100).toFixed(1)}%　κ=${agree.kappa.toFixed(3)}　` +
            `Spearman ${agree.spearman.toFixed(3)}　系统性偏差 ${agree.bias >= 0 ? '+' : ''}${agree.bias.toFixed(2)}`,
        );
        judgeDiag.push(
          `与人工一致率（n=${agree.n}）：完全一致 ${(agree.exact * 100).toFixed(1)}%，κ=${agree.kappa.toFixed(3)}，偏差 ${agree.bias.toFixed(2)}`,
        );
      } else {
        log('\n（人工标注不够 5 条，跳过一致率计算）');
      }
    } else {
      log(`\n未找到人工标注 ${goldPath}，跳过"judge vs 人"的一致率计算。`);
      log('这是接真实模型后**唯一无法由代码替代**的一步：judge 说好、人是否也说好，只有标了才知道。');
    }
  }

  /* ---------- 对比矩阵 ---------- */
  const baseId = baselineRunId(profiles);
  const toRecords = (runId: string): RunRecord[] =>
    results
      .filter((r) => r.profile.run_id === runId)
      .map((r) => {
        const c = cases.find((x) => x.id === r.case_id);
        return {
          run_id: runId,
          case_id: r.case_id,
          run_index: r.run_index,
          model: r.profile.model.id,
          prompt_version: r.profile.prompt_version,
          passed: r.passed,
          score: r.execScore ?? 0,
          cost_usd: r.costCny,
          latency_ms: r.latencyMs,
          unsourced_rate: r.unsourced,
          anchor_coverage: r.anchorCoverage,
          tags: c?.tags ?? { category: 'app', experience_level: 'rich', level: 'intern' },
        };
      });

  const baseRecords = toRecords(baseId);
  let report = `# OfferLens 评测报告（真实模型）\n\n`;
  report += `> 生成时间：${new Date().toISOString()}　评测集：${dataset.version}（${cases.length} 组，种子 ${dataset.seed}）\n`;
  report += `> 每档重复 ${runs} 次　基线：\`${baseId}\`\n\n`;
  report += `## 评测档位与成本\n\n`;
  report += `| 档位 | 模型 | prompt | 价格 | 实际调用成本 |\n| --- | --- | --- | --- | ---: |\n`;
  for (const p of profiles) {
    const cost = results.filter((r) => r.profile.run_id === p.run_id).reduce((s, r) => s + r.costCny, 0);
    report += `| \`${p.run_id}\` | ${p.model.label} | ${p.prompt_version} | ${formatPrice(p.model)} | ¥${cost.toFixed(4)} |\n`;
  }
  const genCostTotal = results.reduce((s, r) => s + r.costCny, 0);
  report += `\n**累计成本：¥${(genCostTotal + judgeCostTotal).toFixed(4)}**` +
    `（生成 ¥${genCostTotal.toFixed(4)} + 裁判 ¥${judgeCostTotal.toFixed(4)}，含断点续跑接上的历史记录）\n`;
  report += `> 本次进程新花：¥${budget.spentCny.toFixed(4)}（预算上限 ¥${budgetLimit}）。` +
    `续跑时该值为 0 是正常现象 —— 说明幂等生效，没有重复付费。\n\n`;

  report += `## 逐档指标（真实模型产出）\n\n`;
  report += `| 档位 | 有产出 | 无产出 | 产出率 | 无源实体率·严口径 | 扣除示例后 | 硬门槛覆盖 | 锚点覆盖 | 达标率(含无产出) |\n`;
  report += `| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |\n`;
  for (const p of profiles) {
    const mine = results.filter((r) => r.profile.run_id === p.run_id);
    const missed = noOutputCount.get(p.run_id) ?? 0;
    const total = mine.length + missed;
    if (total === 0) {
      report += `| \`${p.run_id}\` | 0 | 0 | — | — | — | — | — | — |\n`;
      continue;
    }
    const avg = (f: (r: CaseRun) => number) => mine.reduce((s, r) => s + f(r), 0) / mine.length;
    report +=
      `| \`${p.run_id}\` | ${mine.length} | ${missed} | ${(mine.length / total).toFixed(3)} | ` +
      `${avg((r) => r.unsourced).toFixed(3)} | ` +
      `${avg((r) => r.unsourcedExclExample).toFixed(3)} | ${avg((r) => r.gateCoverage).toFixed(3)} | ` +
      `${avg((r) => r.anchorCoverage).toFixed(3)} | ` +
      `${(mine.filter((r) => r.passed).length / total).toFixed(3)} |\n`;
  }
  report += `\n> **「无产出」为什么必须单独一列**：模型报错或返回空内容 = 这一次跑废了。\n`;
  report += `> 这类运行的建议数是 0。如果直接进质量均值，"无源实体率"会被算成 0 ——\n`;
  report += `> 于是一个四成运行都产不出结果的模型，反而拿到全场最低的无源实体率，看起来最干净。\n`;
  report += `> 口径：**无产出计入达标率分母（记为未达标）、计入 pass^k，但不参与产出质量的均值**。\n`;
  report += `> 本次共 ${noOutputRuns.length} 次无产出。看这张表**先看产出率**，产出率低的档位其余列自动不可比。\n\n`;
  report += `> **统计范围说明（两张表数字不同不是 bug）**：本表按**全部 ${runs}×${cases.length} 次运行**统计，\n`;
  report += `> 衡量的是"随手跑一次能不能达标"的期望；下面的对比矩阵只用 \`run_index=0\` 的 ${cases.length} 组，\n`;
  report += `> 因为配对检验里同一组被算多次会低估方差、把噪声当结论。两个口径都对，问的问题不同。\n`;
  report += `> ⚠️ 但对比矩阵只覆盖**有产出**的运行，所以它回答的是"在都跑得出来的前提下谁更好"；\n`;
  report += `> 产出率本身就差的档位，它的矩阵数字不能当成"可用"的证据。\n\n`;
  report += `> **两个口径都报，理由必须写清楚**：严口径把模型给出的"填写示例"里的实体也计入无源。\n`;
  report += `> 例如模型写「建议改成：『每 15s 发心跳 ping』」——"15s"不在简历里，规则判它无源，技术上没错，\n`;
  report += `> 但它是**模板**而不是对这份简历的事实断言。扣除示例后的那列只统计断言。\n`;
  report += `> 哪个口径才"对"取决于要回答什么问题，所以不合并成一个数。共 ${results.reduce((s, r) => s + r.exampleLocated, 0)} 个实体落在示例片段内。\n\n`;

  log('\n=== 四、对比矩阵 ===\n');
  if (baseRecords.length === 0) {
    log(
      '基线档位没有可用记录，跳过对比矩阵。\n' +
        '常见原因：真实调用全部失败，或预算提前耗尽。先跑通基线档位再谈对比。',
    );
  } else {
    for (const profile of profiles) {
      if (profile.run_id === baseId) continue;
      const cand = toRecords(profile.run_id);
      if (cand.length === 0) {
        log(`— ${profile.run_id}：无记录，跳过`);
        continue;
      }

      const row = compareRuns(baseRecords, cand);
      log(`— ${profile.run_id}`);
      for (const cell of row.cells) {
        if (cell.metric === 'exec_score' && cell.base === 0 && cell.cand === 0) continue;
        const sig =
          cell.method === 'mcnemar'
            ? `McNemar p=${cell.mcnemar?.p.toFixed(4)}`
            : `95%CI [${cell.ci?.lo.toFixed(3)}, ${cell.ci?.hi.toFixed(3)}]`;
        log(
          `   ${cell.label.padEnd(18)} ${cell.base.toFixed(3).padStart(8)} → ${cell.cand
            .toFixed(3)
            .padStart(8)}  ${cell.badge.padEnd(6)}  ${sig}`,
        );
      }
      report += `${compareToMarkdown(row, `${profile.run_id} vs ${baseId}`)}\n\n`;

      const findings = sliceDown(baseRecords, cand, ['experience_level', 'category']);
      const part = partitionFindings(findings);
      if (part.quality.length > 0) {
        log(`   ↓ 能力类切片差异（${part.quality.length} 条）：`);
        for (const f of part.quality.slice(0, 8)) {
          log(
            `      ${f.slice_key}=${f.slice_value} (n=${f.n}) ${f.cell.label}: ` +
              `${f.cell.base.toFixed(3)} → ${f.cell.cand.toFixed(3)}  ${f.cell.badge}`,
          );
        }
      }
      if (part.resource.length > 0) {
        log(`   ↓ 资源类切片差异：共 ${part.resource.length + part.resourceCollapsed} 条（成本/延迟，详情见报告）`);
      }
      report += `${sliceFindingsToMarkdown(findings)}\n\n`;
    }
  }

  /* ---------- 落库 ---------- */
  const dbPath = resolve(ROOT, 'data/offerlens.db');
  if (existsSync(dbPath)) {
    const handle = initDb(dbPath, resolve(ROOT, 'schema/schema.sql'));
    const { db } = handle;
    const now = new Date().toISOString();
    db.prepare(
      'INSERT OR REPLACE INTO dataset (id, version, seed, created_at) VALUES (?, ?, ?, ?)',
    ).run(dataset.id, dataset.version, dataset.seed, dataset.created_at);

    const insRun = db.prepare(
      `INSERT OR REPLACE INTO eval_run
       (id, dataset_id, dataset_version, model, prompt_version, params_json, status,
        budget_limit_usd, spent_usd, seed, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'done', ?, ?, ?, ?, ?)`,
    );
    for (const p of profiles) {
      const cost = results.filter((r) => r.profile.run_id === p.run_id).reduce((s, r) => s + r.costCny, 0);
      insRun.run(
        p.run_id, dataset.id, dataset.version, p.model.id, p.prompt_version,
        JSON.stringify({ runs, judge }), budgetLimit, cost, dataset.seed, now, now,
      );
    }

    const insResult = db.prepare(
      `INSERT OR REPLACE INTO result
       (run_id, case_id, run_index, output_json, scores_json, latency_ms, input_tokens, output_tokens,
        cost_usd, error_type, retry_count, cached, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?)`,
    );
    const insTrace = db.prepare(
      `INSERT OR REPLACE INTO trace
       (trace_id, run_id, case_id, run_index, status, steps_count, total_tokens, cost_usd, latency_ms, error_type, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insStep = db.prepare(
      `INSERT OR REPLACE INTO step
       (span_id, trace_id, parent_id, type, name, start_ms, end_ms, input_tokens, output_tokens, retry_of, error, attrs_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    for (const r of results) {
      insResult.run(
        r.profile.run_id, r.case_id, r.run_index,
        JSON.stringify({ suggestions: r.suggestions }),
        JSON.stringify({
          passed: r.passed,
          unsourced_rate: r.unsourced,
          gate_coverage: r.gateCoverage,
          anchor_coverage: r.anchorCoverage,
          exec_score: r.execScore,
          invalid_anchors: r.invalidAnchors,
        }),
        r.latencyMs, r.inputTokens, r.outputTokens, r.costCny, r.error, now,
      );

      const spans = readJsonlSafe(tracePath(r.profile.run_id, r.case_id, r.run_index)) as StepSpan[];
      if (spans.length === 0) continue;
      const m = computeStepMetrics(spans);
      const traceId = spans[0]?.trace_id ?? `${r.profile.run_id}__${r.case_id}__r${r.run_index}`;
      insTrace.run(
        traceId, r.profile.run_id, r.case_id, r.run_index,
        r.error ? 'failed' : 'ok', m.spanCount, m.totalTokens, r.costCny, m.durationMs, r.error, now,
      );
      for (const s of spans) {
        insStep.run(
          s.span_id, s.trace_id, s.parent_id, s.type, s.name, s.start, s.end,
          s.tokens?.input ?? null, s.tokens?.output ?? null,
          s.retry_of ?? null, s.error ?? null, JSON.stringify(s.attrs ?? {}),
        );
      }
    }
    const counts = db.prepare('SELECT COUNT(*) AS c FROM result').get() as { c: number };
    log(`\n=== 五、落库 ===\n写入 result 共 ${counts.c} 行（历史累积）；本次 ${results.length} 行`);
    db.close();
  }

  /* ---------- 报告尾部 ---------- */
  report += `\n## 诊断信息\n\n`;
  report += `- 无产出的运行（模型报错 / 返回空）：${noOutputRuns.length} 次。\n`;
  report += `- 按档位拆：${profiles.map((p) => `\`${p.run_id}\` ${noOutputCount.get(p.run_id) ?? 0} 次`).join('　')}\n`;
  report += `- 模型回填但不存在的段 ID（"假装有出处"）：共 ${results.reduce((s, r) => s + r.invalidAnchors.length, 0)} 个，已全部置空，未计入锚点覆盖率。\n`;
  report += `- 运行失败：${failures.length} 次\n`;
  for (const d of judgeDiag) report += `- ${d}\n`;
  report += `\n## 诚实说明\n\n`;
  report += `- 判定规则（无源实体率 ≤ 15% 且硬门槛覆盖 ≥ 50%）是**代理指标**，不等于"建议是对的"。\n`;
  report += `- 本报告**未经人工标注校准**。judge 的打分在与人一致率达标签明之前，只能当参考，不能当结论。\n`;
  report += `- 关键限制：样本 ${cases.length} 组，切片下钻时单格 n 更小；「不显著」不等于没变化。\n`;
  report += `- **产出率是前置门槛**：产出率低的档位，其余质量指标不能横向比 —— 它是"跑得出来的那部分"的表现。\n`;
  report += `- 全部原始数据（含每条建议全文与 trace）在 \`data/real/\`，可复算。\n`;

  const reportPath = resolve(ROOT, `reports/real-${stamp}.md`);
  writeFileSync(reportPath, report, 'utf8');
  log(`\n报告已写入 ${reportPath}`);
  log(`原始数据：${runsPath}`);
  log(`\n本次总成本：¥${budget.spentCny.toFixed(4)}`);

  const finishedAt = new Date().toISOString();
  const summary: EvalSummary = {
    profiles: profiles.map((p) => p.run_id),
    caseCount: cases.length,
    totalRuns: tasks.length,
    runs,
    judge,
    spentCny: Number(budget.spentCny.toFixed(4)),
    genCostTotal: Number(genCostTotal.toFixed(4)),
    judgeCostTotal: Number(judgeCostTotal.toFixed(4)),
    noOutput: noOutputRuns.length,
    failures: failures.length,
    reportPath,
    startedAt,
    finishedAt,
    durationMs: Date.parse(finishedAt) - Date.parse(startedAt),
  };
  emit({ type: 'done', summary });
  return summary;
}

/** readJsonl 对不存在的文件会抛；这里包一层返回空数组，让"还没跑过"是正常状态 */
function readJsonlSafe(path: string): unknown[] {
  if (!existsSync(path)) return [];
  try {
    return readJsonl<unknown>(path);
  } catch {
    return [];
  }
}
