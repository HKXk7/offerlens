import type { CaseDetailResult, CasesResponse, CompareResult, LeaderboardResponse, MetaResponse } from './types';

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

export const api = {
  meta: () => getJson<MetaResponse>('/api/meta'),
  leaderboard: () => getJson<LeaderboardResponse>('/api/leaderboard'),
  compare: (base: string, cand: string) =>
    getJson<CompareResult>(
      `/api/compare?base=${encodeURIComponent(base)}&cand=${encodeURIComponent(cand)}`,
    ),
  cases: () => getJson<CasesResponse>('/api/cases'),
  caseDetail: (runId: string, caseId: string) =>
    getJson<CaseDetailResult>(
      `/api/case?run_id=${encodeURIComponent(runId)}&case_id=${encodeURIComponent(caseId)}`,
    ),
};
