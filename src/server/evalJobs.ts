/**
 * 评测 job 管理 —— 把长耗时、花钱的评测跑批放到后台执行。
 *
 * 为什么不能直接在 HTTP handler 里 await runEval()：
 *   一次真实评测要跑几十到几百次模型调用，耗时以分钟计；HTTP 请求会超时，
 *   前端也会一直转圈。所以这里用「后台 job + 轮询」：
 *     POST /api/eval         启动评测，立即返回 202 + jobId
 *     GET  /api/eval/status  轮询当前 job 的进度 / 日志 / 结果
 *
 * 同一时刻只允许一个评测在跑（写 data/real 不能并发）。缺 key / 档位不匹配
 * 这些前置错误，在启动前就同步检查、直接返回 4xx，而不是让用户等轮询才发现失败。
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EvalError,
  runEval,
  type EvalOptions,
  type EvalProgress,
  type EvalSummary,
} from '../eval/runner.js';
import { loadEnv } from '../lib/env.js';
import { PROVIDERS, defaultJudge, defaultProfiles, resolveApiKey } from '../agent/catalog.js';
import { invalidateCache } from './analyze.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

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

let current: EvalJob | null = null;
const history: EvalJob[] = [];
const MAX_LOGS = 800;
const MAX_HISTORY = 20;
let seq = 0;

export function currentJob(): EvalJob | null {
  return current;
}

export function jobHistory(): EvalJob[] {
  return history;
}

export type StartResult =
  | { ok: true; job: EvalJob }
  | { ok: false; error: string; code: string };

/** 前置检查：档位匹配 + API key 齐备。返回非 null 表示失败（同步快速失败）。 */
function precheck(opts: EvalOptions): StartResult | null {
  const wanted = opts.profiles ?? null;
  const profiles = wanted
    ? defaultProfiles().filter((p) => wanted.includes(p.run_id))
    : defaultProfiles();
  if (profiles.length === 0) {
    return {
      ok: false,
      error: `没有匹配的档位。可选：${defaultProfiles().map((p) => p.run_id).join(' / ')}`,
      code: 'no_profiles',
    };
  }
  if (opts.dryRun) return null; // dry-run 不发请求，无需 key

  loadEnv(resolve(ROOT, '.env'));
  const judge = opts.judge ?? true;
  const needed = new Set(profiles.map((p) => p.model.provider));
  if (judge) needed.add(defaultJudge().model.provider);
  const missing = [...needed].filter((id) => {
    const cfg = PROVIDERS[id];
    if (cfg.apiKeyEnv === null) return false;
    const anyModel = [...profiles.map((p) => p.model), defaultJudge().model].find((m) => m.provider === id);
    return anyModel ? resolveApiKey(anyModel).missing : false;
  });
  if (missing.length > 0) {
    const lines = missing.map((id) => `${PROVIDERS[id].label}（${PROVIDERS[id].apiKeyEnv}）`).join('；');
    return { ok: false, error: `缺少 API Key：${lines}。请写入 .env 后重试`, code: 'missing_key' };
  }
  return null;
}

export function startEval(opts: EvalOptions): StartResult {
  if (current && current.status === 'running') {
    return { ok: false, error: '已有评测正在运行，请等它完成后再启动新的', code: 'already_running' };
  }

  const pre = precheck(opts);
  if (pre) return pre;

  const normalized: EvalJobOpts = {
    profiles: opts.profiles ?? null,
    limit: opts.limit ?? null,
    runs: opts.runs ?? 3,
    judge: opts.judge ?? true,
    budget: opts.budget ?? 100,
    concurrency: opts.concurrency ?? 4,
    dryRun: opts.dryRun ?? false,
  };

  const job: EvalJob = {
    id: `eval-${Date.now().toString(36)}-${++seq}`,
    status: 'running',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    opts: normalized,
    progress: null,
    logs: [],
    summary: null,
    error: null,
    errorCode: null,
  };
  current = job;
  history.unshift(job);
  if (history.length > MAX_HISTORY) history.length = MAX_HISTORY;

  void runEval(normalized, (e) => {
    if (e.type === 'log') {
      job.logs.push(e.line);
      if (job.logs.length > MAX_LOGS) job.logs.splice(0, job.logs.length - MAX_LOGS);
    } else if (e.type === 'progress') {
      job.progress = e.progress;
    } else if (e.type === 'done') {
      job.status = 'done';
      job.finishedAt = new Date().toISOString();
      job.summary = e.summary;
      invalidateCache();
    }
  }).catch((err) => {
    job.status = 'failed';
    job.finishedAt = new Date().toISOString();
    job.error = err instanceof Error ? err.message : String(err);
    job.errorCode = err instanceof EvalError ? err.code : 'internal';
  });

  return { ok: true, job };
}
