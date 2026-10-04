/**
 * 误差函数与几个分布函数。
 *
 * 为什么自己写而不用库：整个项目只需要这一小块数学，
 * 引一个统计库（jstat 之类）不划算，而且"这段代码我读得懂"在面试里是加分项。
 *
 * erf 用 Abramowitz & Stegun 7.1.26 近似，绝对误差 < 1.5e-7，
 * 对显著性判断完全够（我们要的是"p 是不是小于 0.05"，不是小数点后十位）。
 */

const A1 = 0.254829592;
const A2 = -0.284496736;
const A3 = 1.421413741;
const A4 = -1.453152027;
const A5 = 1.061405429;
const P = 0.3275911;

export function erf(x: number): number {
  if (Number.isNaN(x)) return NaN;
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + P * ax);
  const y =
    1 -
    ((((A5 * t + A4) * t + A3) * t + A2) * t + A1) * t * Math.exp(-ax * ax);
  return sign * y;
}

/** 标准正态分布 CDF */
export function normalCdf(x: number): number {
  if (x === Infinity) return 1;
  if (x === -Infinity) return 0;
  return 0.5 * (1 + erf(x / Math.SQRT2));
}

/**
 * 卡方分布（df = 1）的上尾概率 P(X > x)。
 *
 * 推导：df=1 时 chi2 = Z²，所以 P(chi2 > x) = P(|Z| > sqrt(x)) = 2(1 - Φ(sqrt(x)))，
 * 而 2(1 - Φ(√x)) = 1 - erf(√(x/2))。两条路等价，这里用 erf 形式。
 *
 * 校验点：P(chi2 > 3.8415) ≈ 0.05（卡方 0.05 临界值）
 */
export function chiSquareSf1(x: number): number {
  if (!Number.isFinite(x) || x <= 0) return 1;
  return 1 - erf(Math.sqrt(x / 2));
}

function logGamma(z: number): number {
  // Lanczos 近似，够用
  const g = 7;
  const C = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028,
    771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (z < 0.5) {
    return Math.log(Math.PI / Math.sin(Math.PI * z)) - logGamma(1 - z);
  }
  const zz = z - 1;
  let x = C[0];
  for (let i = 1; i < g + 2; i++) x += C[i] / (zz + i);
  const t = zz + g + 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (zz + 0.5) * Math.log(t) - t + Math.log(x);
}

function logBinomial(n: number, k: number): number {
  return logGamma(n + 1) - logGamma(k + 1) - logGamma(n - k + 1);
}

/** P(X = k)，X ~ B(n, p) */
export function binomialPmf(n: number, k: number, p: number): number {
  if (k < 0 || k > n) return 0;
  return Math.exp(logBinomial(n, k) + k * Math.log(p) + (n - k) * Math.log(1 - p));
}

/** P(X <= k)，X ~ B(n, p) */
export function binomialCdf(n: number, k: number, p: number): number {
  if (k < 0) return 0;
  if (k >= n) return 1;
  let sum = 0;
  for (let i = 0; i <= k; i++) sum += binomialPmf(n, i, p);
  return Math.min(1, sum);
}
