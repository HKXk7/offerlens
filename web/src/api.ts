import type {
  CaseDetailResult,
  CasesResponse,
  CompareResult,
  EvalJob,
  EvalJobsResponse,
  EvalStatusResponse,
  JdView,
  LeaderboardResponse,
  MetaResponse,
  StartEvalRequest,
} from './types';

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = await res.json();
      if (body && typeof body.error === 'string') detail = body.error;
    } catch {
      /* ignore */
    }
    throw new Error(`${res.status} ${detail}`);
  }
  return res.json() as Promise<T>;
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const b = await res.json();
      if (b && typeof b.error === 'string') detail = b.error;
    } catch {
      /* ignore */
    }
    throw new Error(`${res.status} ${detail}`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  meta: () => getJson<MetaResponse>('/api/meta'),
  leaderboard: () => getJson<LeaderboardResponse>('/api/leaderboard'),
  compare: (base: string, cand: string) =>
    getJson<CompareResult>(
      `/api/compare?base=${encodeURIComponent(base)}&cand=${encodeURIComponent(cand)}`,
    ),
  cases: () => getJson<CasesResponse>('/api/cases'),
  jds: () => getJson<JdView>('/api/jds'),
  caseDetail: (runId: string, caseId: string) =>
    getJson<CaseDetailResult>(
      `/api/case?run_id=${encodeURIComponent(runId)}&case_id=${encodeURIComponent(caseId)}`,
    ),
  startEval: (req: StartEvalRequest) => postJson<{ job: EvalJob }>('/api/eval', req),
  evalStatus: () => getJson<EvalStatusResponse>('/api/eval/status'),
  evalJobs: () => getJson<EvalJobsResponse>('/api/eval/jobs'),
};
