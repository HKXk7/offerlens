/**
 * pass^k 与「每次成功成本」（策划书 3.3）。
 *
 * 必须和 pass@k 严格区分——这是面试里最容易被追问的一对概念：
 *   pass@k  = k 次里**至少一次**成功 → 衡量"能力上限"（这个模型理论上能不能做出来）
 *   pass^k  = k 次里**全部**成功     → 衡量"可靠性"（这个模型能不能拿去做产品）
 *
 * agent 是强非确定的：同一份简历跑两次，一次给对了 5 条建议，一次编了 2 个数字。
 * 只跑一次然后说"成功率 80%"，是在拿运气当能力。所以要 pass^k。
 */

export interface RunOutcome {
  /** 配置标识（模型 × prompt 版本）。pass^k 必须在**同一配置内**统计，跨配置混在一起算没有意义 */
  run_id: string;
  case_id: string;
  run_index: number;
  passed: boolean;
  cost_usd?: number;
}

export interface PassKResult {
  k: number;
  /** 有完整 k 次记录的 case 数 */
  eligibleCases: number;
  /** k 次全部达标的 case 数 */
  passedCases: number;
  /** pass^k 的值 */
  rate: number;
  /** 记录不足 k 次的 case，单独列出来（这些不能被悄悄算成失败） */
  insufficientCases: string[];
  /** 每个 case 通过了几次，便于看"全过/全挂/不稳定"三档分布 */
  perCase: Array<{ case_id: string; runs: number; passedRuns: number }>;
}

export function passK(outcomes: readonly RunOutcome[], k: number): PassKResult {
  if (!Number.isInteger(k) || k <= 0) throw new Error(`pass^k 的 k 必须是正整数，收到 ${k}`);

  // 按 (run_id, case_id) 分组：同一组的 3 次重复才算 pass^3。
  // 早先按 case_id 单键分组时，三个模型的重复运行被混在一起，
  // 每个 case 变成 9 次记录 —— pass^3 直接算错，这里修掉。
  const byCase = new Map<string, RunOutcome[]>();
  const label = new Map<string, string>();
  for (const o of outcomes) {
    const key = `${o.run_id}::${o.case_id}`;
    const arr = byCase.get(key) ?? [];
    arr.push(o);
    byCase.set(key, arr);
    label.set(key, o.case_id);
  }

  let eligible = 0;
  let passed = 0;
  const insufficient: string[] = [];
  const perCase: PassKResult['perCase'] = [];

  for (const [key, runs] of byCase) {
    const caseId = label.get(key) ?? key;
    const sorted = runs.slice().sort((a, b) => a.run_index - b.run_index);
    const passedRuns = sorted.filter((r) => r.passed).length;
    perCase.push({ case_id: caseId, runs: sorted.length, passedRuns });
    if (sorted.length < k) {
      insufficient.push(caseId); // 记录不足的不能算失败，也不能算成功，只能排除
      continue;
    }
    eligible++;
    if (sorted.slice(0, k).every((r) => r.passed)) passed++;
  }

  return {
    k,
    eligibleCases: eligible,
    passedCases: passed,
    rate: eligible === 0 ? 0 : passed / eligible,
    insufficientCases: insufficient,
    perCase: perCase.sort((a, b) => a.case_id.localeCompare(b.case_id)),
  };
}

/**
 * pass@k 的无偏估计：1 - C(n-c, k) / C(n, k)
 *   n = 采样次数，c = 成功次数
 *
 * 为什么不用朴素的"k 次里至少一次成功"：那个是有偏的，
 * 同样的 n 和 c，朴素算法会低估 pass@k。这是 HumanEval 论文里明确处理过的问题。
 */
export function passAtKUnbiased(n: number, c: number, k: number): number {
  if (k > n) throw new Error(`pass@k 要求 k <= n，收到 n=${n} k=${k}`);
  if (c === 0) return 0;
  if (n - c < k) return 1;
  let prod = 1;
  for (let i = 0; i < k; i++) prod *= (n - c - i) / (n - i);
  return 1 - prod;
}

export function costPerSuccess(totalCostUsd: number, successCount: number): number {
  return successCount === 0 ? Number.POSITIVE_INFINITY : totalCostUsd / successCount;
}

/**
 * 稳定性分档：把每个 case 归到「全过 / 全挂 / 不稳定」三档。
 * 这张表比一个孤零零的 pass^3 数字有用得多——
 * "在 6 组上全过、在 2 组上时好时坏"比"pass^3 = 0.75"能讲出更多东西。
 */
export interface StabilityBreakdown {
  always: number;
  never: number;
  flaky: number;
  /** 不稳定率：flaky / 有记录的 case 数 */
  flakyRate: number;
}

export function stabilityBreakdown(
  outcomes: readonly RunOutcome[],
  expectedRuns: number,
): StabilityBreakdown {
  const byCase = new Map<string, RunOutcome[]>();
  for (const o of outcomes) {
    const key = `${o.run_id}::${o.case_id}`;
    const arr = byCase.get(key) ?? [];
    arr.push(o);
    byCase.set(key, arr);
  }
  let always = 0;
  let never = 0;
  let flaky = 0;
  for (const runs of byCase.values()) {
    if (runs.length < expectedRuns) continue;
    const p = runs.filter((r) => r.passed).length;
    if (p === runs.length) always++;
    else if (p === 0) never++;
    else flaky++;
  }
  const total = always + never + flaky;
  return { always, never, flaky, flakyRate: total === 0 ? 0 : flaky / total };
}
