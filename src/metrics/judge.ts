import { mean, spearman } from '../stats/rank.js';
import { cohenKappa } from '../stats/kappa.js';

/**
 * LLM-judge 的聚合与校准（策划书 3.3）。
 *
 * judge 的三种偏见必须处理，否则三个模型比出来的结论是假的：
 *   1. 同源偏见 —— judge 偏袒同族模型。对策：judge 与被测模型不同源。
 *   2. 位置偏见 —— 偏爱排在前面/后面的答案。对策：正反序各跑一次取平均。
 *   3. 长度偏见 —— 偏爱更长的答案。对策：prompt 里显式禁止，并统计长度与得分的相关性。
 *
 * 最后必须用一批人工打分去量 judge：算一致率和秩相关。
 * "judge 说 A 比 B 好"和"人也说 A 比 B 好"是两件事，只有后者能写进结论。
 */

export type Rubric = readonly { score: number; label: string; criteria: string }[];

export const DEFAULT_EXECUTABILITY_RUBRIC: Rubric = [
  { score: 1, label: '套话', criteria: '「突出你的优势」这类，看完不知道改哪一行' },
  { score: 2, label: '方向对但不可直接执行', criteria: '说了要量化但没有给出具体改法' },
  { score: 3, label: '可直接照做', criteria: '明确指出改哪一段、改成什么，且不引入简历里没有的事实' },
];

export interface ExecutabilityResult {
  /** 平均可执行分（1–3） */
  mean: number;
  /** 达到 3 分的比例 */
  rate3: number;
  /** 各分数分布 */
  distribution: Record<number, number>;
  n: number;
}

export function executability(scores: readonly number[]): ExecutabilityResult {
  const distribution: Record<number, number> = { 1: 0, 2: 0, 3: 0 };
  for (const s of scores) {
    const key = Math.round(s);
    distribution[key] = (distribution[key] ?? 0) + 1;
  }
  return {
    mean: mean(scores),
    rate3: scores.length === 0 ? 0 : scores.filter((s) => Math.round(s) === 3).length / scores.length,
    distribution,
    n: scores.length,
  };
}

/**
 * 正反序各跑一次的合并方式：取平均。
 * 只跑一次的话，位置偏议会系统性抬高"被放在前面"的那个版本。
 */
export function mergeOrderDebiased(forward: readonly number[], backward: readonly number[]): number[] {
  if (forward.length !== backward.length) {
    throw new Error(`正反序样本长度不一致：${forward.length} vs ${backward.length}`);
  }
  return forward.map((f, i) => (f + backward[i]) / 2);
}

export interface JudgeAgreementResult {
  n: number;
  /** 完全一致率 */
  exact: number;
  /** 相差不超过 1 分的比例（3 分制下这个数字通常比 exact 更有意义） */
  within1: number;
  /** 平均绝对偏差 */
  meanAbsDiff: number;
  /** 秩相关：judge 与人的排序是否一致 */
  spearman: number;
  /** 把分数当类别算的 kappa */
  kappa: number;
  /** judge 系统性偏高/偏低的倾向 */
  bias: number;
}

export function judgeHumanAgreement(
  judge: readonly number[],
  human: readonly number[],
): JudgeAgreementResult {
  if (judge.length !== human.length) {
    throw new Error(`judge 与人工打分长度不一致：${judge.length} vs ${human.length}`);
  }
  if (judge.length === 0) throw new Error('judge 一致性样本为空');

  let exact = 0;
  let within1 = 0;
  let absSum = 0;
  for (let i = 0; i < judge.length; i++) {
    const d = Math.abs(judge[i] - human[i]);
    if (d === 0) exact++;
    if (d <= 1) within1++;
    absSum += d;
  }

  return {
    n: judge.length,
    exact: exact / judge.length,
    within1: within1 / judge.length,
    meanAbsDiff: absSum / judge.length,
    spearman: spearman(judge, human),
    kappa: cohenKappa(judge, human).kappa,
    bias: mean(judge) - mean(human),
  };
}

/**
 * 长度偏见检查：如果"答案越长分越高"的相关性很明显，judge 的结论就不能直接用。
 * 相关系数 > 0.5 就说明 judge 基本在按长度打分。
 */
export function lengthBiasCorrelation(
  lengths: readonly number[],
  scores: readonly number[],
): { correlation: number; suspicious: boolean } {
  const correlation = spearman(lengths, scores);
  return { correlation, suspicious: Math.abs(correlation) > 0.5 };
}
