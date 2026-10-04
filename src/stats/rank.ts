/**
 * 排序与分位数相关的小工具。
 *
 * 为什么不用平均值：延迟和成本的分布长尾很重，平均值会被少数极端值拉偏，
 * 用户感知到的是长尾（最慢的那几次）。所以一律报分位数。
 */

/** 平均秩（并列取相同秩的平均），用于 Spearman 相关 */
export function ranks(values: readonly number[]): number[] {
  const idx = values.map((v, i) => ({ v, i }));
  idx.sort((x, y) => x.v - y.v);
  const out = new Array<number>(values.length);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1].v === idx[i].v) j++;
    const avg = (i + j) / 2 + 1; // 秩从 1 开始
    for (let k = i; k <= j; k++) out[idx[k].i] = avg;
    i = j + 1;
  }
  return out;
}

export function pearson(x: readonly number[], y: readonly number[]): number {
  const n = x.length;
  if (n !== y.length) throw new Error('pearson 要求两个数组等长');
  // n < 2 时相关系数本身就无定义。这里返回 0（= "未检测到关系"）而不是抛错：
  // 调用方是"长度偏见检查"，样本为空时正确答案就是"没发现偏见"。
  // 早先这里抛错，导致整批判分任务在第 0 条就崩掉、钱白花 —— 真踩过。
  if (n < 2) return 0;
  const mx = x.reduce((s, v) => s + v, 0) / n;
  const my = y.reduce((s, v) => s + v, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i] - mx;
    const dy = y[i] - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  if (sxx === 0 || syy === 0) return 0; // 某一边全相等，相关系数无定义
  return sxy / Math.sqrt(sxx * syy);
}

/** Spearman 秩相关：judge 打分与人工打分的秩序一致性 */
export function spearman(x: readonly number[], y: readonly number[]): number {
  return pearson(ranks(x), ranks(y));
}

/**
 * 分位数（线性插值法，与大多数统计软件一致）。
 * @param ps 例如 [0.5, 0.95]
 */
export function percentiles(values: readonly number[], ps: readonly number[]): number[] {
  if (values.length === 0) throw new Error('percentiles 收到空数组');
  const sorted = values.slice().sort((a, b) => a - b);
  return ps.map((p) => {
    if (p <= 0) return sorted[0];
    if (p >= 1) return sorted[sorted.length - 1];
    const pos = (sorted.length - 1) * p;
    const lo = Math.floor(pos);
    const hi = Math.ceil(pos);
    if (lo === hi) return sorted[lo];
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
  });
}

export function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

/** 取两个比例/分数之和中的最小值？不是——这里是安全的除法，分母 0 时返回 0。 */
export function safeDiv(num: number, den: number): number {
  return den === 0 ? 0 : num / den;
}
