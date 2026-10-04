import { mulberry32, type Rng } from '../lib/prng.js';

/**
 * 配对 bootstrap 置信区间。
 *
 * 为什么是"配对"：a 和 b 是同一样本在不同条件下（比如两个模型）的结果，
 * 重采样时**必须用同一个索引**取两边，否则就变成两个独立样本的比较，
 * 把 case 难度的共同方差丢掉了，CI 会虚宽。
 *
 * 为什么要固定种子：不固定的话，同一个对比每次点"重新计算"数字都会变一点，
 * 面试官会当场问你"为什么两次跑出来不一样"。
 */

export interface PairedBootstrapOptions {
  iters?: number;
  seed?: number;
  /** 显著性水平，默认 0.05 → 95% CI */
  alpha?: number;
}

export interface PairedBootstrapResult {
  /** 点估计：b - a 的均值（正数 = 候选更好） */
  meanDiff: number;
  lo: number;
  hi: number;
  alpha: number;
  iters: number;
  seed: number;
  n: number;
  /** 95% CI 是否不包含 0（即差异在统计上站得住） */
  excludesZero: boolean;
}

/**
 * @param a 基线在每个 case 上的得分（0/1 或连续值）
 * @param b 候选在同一批 case 上的得分，顺序必须与 a 严格对应
 */
export function pairedBootstrapCI(
  a: readonly number[],
  b: readonly number[],
  opts: PairedBootstrapOptions = {},
): PairedBootstrapResult {
  if (a.length !== b.length) {
    throw new Error(`配对样本长度不一致：${a.length} vs ${b.length}`);
  }
  if (a.length === 0) throw new Error('配对样本为空，无法做 bootstrap');

  const pairs: Array<[number, number]> = [];
  for (let i = 0; i < a.length; i++) pairs.push([a[i], b[i]]);

  const iters = opts.iters ?? 10000;
  const seed = opts.seed ?? 42;
  const alpha = opts.alpha ?? 0.05;

  const rng: Rng = mulberry32(seed);
  const n = pairs.length;
  const diffs = new Array<number>(iters);

  for (let it = 0; it < iters; it++) {
    let sum = 0;
    for (let j = 0; j < n; j++) {
      const k = rng.int(n); // 同一个 k 同时取 a 和 b —— 这就是"配对"
      sum += pairs[k][1] - pairs[k][0];
    }
    diffs[it] = sum / n;
  }
  diffs.sort((x, y) => x - y);

  const loIdx = Math.max(0, Math.floor(iters * (alpha / 2)));
  const hiIdx = Math.min(iters - 1, Math.ceil(iters * (1 - alpha / 2)) - 1);

  let observed = 0;
  for (const [x, y] of pairs) observed += y - x;
  observed /= n;

  const lo = diffs[loIdx];
  const hi = diffs[hiIdx];

  return {
    meanDiff: observed,
    lo,
    hi,
    alpha,
    iters,
    seed,
    n,
    excludesZero: lo > 0 || hi < 0,
  };
}
