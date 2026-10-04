import { describe, expect, it } from 'vitest';
import {
  binomialCdf,
  binomialPmf,
  chiSquareSf1,
  erf,
  normalCdf,
} from '../src/stats/distributions.js';
import { mcnemar, mcnemarFromPairs } from '../src/stats/mcnemar.js';
import { pairedBootstrapCI } from '../src/stats/bootstrap.js';
import { cohenKappa } from '../src/stats/kappa.js';
import { mean, pearson, percentiles, ranks, spearman } from '../src/stats/rank.js';

describe('分布函数（口径错了整套结论都错，所以逐个对标准值）', () => {
  it('erf 与标准值吻合', () => {
    expect(erf(0)).toBeCloseTo(0, 7);
    expect(erf(1)).toBeCloseTo(0.8427007929, 6);
    expect(erf(-1)).toBeCloseTo(-0.8427007929, 6);
  });

  it('正态 CDF：Φ(1.96) ≈ 0.975', () => {
    expect(normalCdf(1.96)).toBeCloseTo(0.975, 4);
    expect(normalCdf(0)).toBeCloseTo(0.5, 8);
  });

  it('卡方 df=1 的上尾概率：临界值 3.8415 对应 p ≈ 0.05', () => {
    expect(chiSquareSf1(3.8415)).toBeCloseTo(0.05, 4);
    expect(chiSquareSf1(0)).toBe(1);
    expect(chiSquareSf1(-1)).toBe(1);
  });

  it('二项分布', () => {
    expect(binomialPmf(4, 2, 0.5)).toBeCloseTo(0.375, 10);
    // P(X<=3), X~B(15,0.5) = (1+15+105+455)/32768
    expect(binomialCdf(15, 3, 0.5)).toBeCloseTo(576 / 32768, 8);
  });
});

describe('McNemar：只看翻转样本', () => {
  it('卡方近似 + 连续性校正：b=10, c=2 → chi2=49/12, p≈0.0433', () => {
    const r = mcnemar(10, 2, { useExact: false });
    expect(r.statistic).toBeCloseTo(49 / 12, 8);
    expect(r.p).toBeCloseTo(0.04332, 4);
    expect(r.significant).toBe(true);
    expect(r.direction).toBe('worse'); // b 多 = 候选更差
  });

  it('方向：c 多说明候选更好', () => {
    expect(mcnemar(2, 10, { useExact: false }).direction).toBe('better');
    expect(mcnemar(4, 4, { useExact: false }).direction).toBe('same');
  });

  it('b=c 时连续性校正把统计量压到 0，p = 1', () => {
    const r = mcnemar(5, 5, { useExact: false });
    expect(r.statistic).toBe(0);
    expect(r.p).toBe(1);
  });

  it('|b-c|=2 时 chi2 = (2-1)^2/10 = 0.1，p ≈ 0.7518', () => {
    const r = mcnemar(6, 4, { useExact: false });
    expect(r.statistic).toBeCloseTo(0.1, 10);
    expect(r.p).toBeCloseTo(0.7518, 3);
    expect(r.significant).toBe(false);
  });

  it('完全无翻转时 p = 1', () => {
    expect(mcnemar(0, 0).p).toBe(1);
  });

  it('精确二项检验：b=3, c=12 → p = 2*P(X<=3) = 1152/32768', () => {
    const r = mcnemar(3, 12);
    expect(r.method).toBe('exact-binomial');
    expect(r.p).toBeCloseTo(1152 / 32768, 8);
    expect(r.significant).toBe(true);
  });

  it('样本大时自动切到卡方', () => {
    expect(mcnemar(30, 12).method).toBe('chi-square');
  });

  it('从配对记录直接统计 b / c', () => {
    const base = [true, true, false, false, true];
    const cand = [false, true, true, false, true];
    const r = mcnemarFromPairs(base, cand);
    expect(r.b).toBe(1); // 基线对、候选错
    expect(r.c).toBe(1); // 基线错、候选对
    expect(r.n).toBe(2);
  });

  it('长度不一致要报错，不能悄悄按短的算', () => {
    expect(() => mcnemarFromPairs([true], [true, false])).toThrow(/长度不一致/);
  });
});

describe('配对 bootstrap', () => {
  it('无差异时 CI 必须包含 0', () => {
    const a = [0, 1, 1, 0, 1, 0, 1, 1, 0, 0];
    const r = pairedBootstrapCI(a, a.slice(), { seed: 7, iters: 2000 });
    expect(r.meanDiff).toBe(0);
    expect(r.lo).toBe(0);
    expect(r.hi).toBe(0);
    expect(r.excludesZero).toBe(false);
  });

  it('差异明显时 CI 不包含 0', () => {
    const a = new Array(24).fill(0);
    const b = new Array(24).fill(1);
    const r = pairedBootstrapCI(a, b, { seed: 7, iters: 2000 });
    expect(r.meanDiff).toBe(1);
    expect(r.excludesZero).toBe(true);
  });

  it('同一种子必须复现同一结果（否则面试官会问为什么两次不一样）', () => {
    // 用连续值：0/1 数据的 bootstrap 均值会量化到 k/n，不同种子容易撞在同一个值上
    const a = [0.2, 0.9, 0.4, 0.75, 0.55, 0.3, 0.1, 0.85, 0.45, 0.6, 0.25, 0.7];
    const b = [0.35, 0.95, 0.4, 0.6, 0.7, 0.5, 0.2, 0.8, 0.65, 0.55, 0.4, 0.9];
    const r1 = pairedBootstrapCI(a, b, { seed: 20261004, iters: 1500 });
    const r2 = pairedBootstrapCI(a, b, { seed: 20261004, iters: 1500 });
    expect(r1).toEqual(r2);
    const r3 = pairedBootstrapCI(a, b, { seed: 1, iters: 1500 });
    expect(r3.lo).not.toBe(r1.lo);
  });

  it('重采样必须成对取：配对差值恒定时 CI 必须塌成一个点', () => {
    // a、b 各自方差很大，但 b - a 恒等于 0.5。
    // 成对重采样 → 每个重采样均值都是 0.5，CI = [0.5, 0.5]。
    // 若实现错误地各自独立重采样，两边方差会叠加，CI 会明显变宽。
    const a = [0, 1, 0, 1, 0, 1, 0, 1];
    const b = a.map((v) => v + 0.5);
    const r = pairedBootstrapCI(a, b, { seed: 3, iters: 4000 });
    expect(r.meanDiff).toBeCloseTo(0.5, 10);
    expect(r.lo).toBeCloseTo(0.5, 10);
    expect(r.hi).toBeCloseTo(0.5, 10);
    expect(r.excludesZero).toBe(true);
  });
});

describe("Cohen's kappa", () => {
  it('完全一致 → 1', () => {
    expect(cohenKappa([1, 1, 0, 0], [1, 1, 0, 0]).kappa).toBeCloseTo(1, 10);
  });

  it('手算样例：Po=0.7, Pe=0.5 → kappa=0.4', () => {
    const a = [1, 1, 1, 1, 1, 0, 0, 0, 0, 0];
    const b = [1, 1, 1, 0, 0, 1, 0, 0, 0, 0];
    const r = cohenKappa(a, b);
    expect(r.observed).toBeCloseTo(0.7, 10);
    expect(r.expected).toBeCloseTo(0.5, 10);
    expect(r.kappa).toBeCloseTo(0.4, 10);
  });

  it('两边各用一个互不相同的类别 → kappa=0', () => {
    expect(cohenKappa([1, 1], [2, 2]).kappa).toBe(0);
  });
});

describe('秩与分位数', () => {
  it('并列取平均秩', () => {
    expect(ranks([10, 20, 20, 40])).toEqual([1, 2.5, 2.5, 4]);
  });

  it('Spearman', () => {
    expect(spearman([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 10);
    expect(spearman([1, 2, 3], [3, 2, 1])).toBeCloseTo(-1, 10);
    expect(spearman([1, 2, 3], [5, 5, 5])).toBe(0); // 一边无方差
  });

  it('Pearson 与手算一致', () => {
    expect(pearson([1, 2, 3], [2, 4, 6])).toBeCloseTo(1, 10);
  });

  it('分位数用线性插值', () => {
    expect(percentiles([1, 2, 3, 4], [0.5])[0]).toBeCloseTo(2.5, 10);
    expect(percentiles([1, 2, 3, 4], [1])[0]).toBe(4);
    expect(percentiles([1, 2, 3, 4], [0.95])[0]).toBeCloseTo(3.85, 10);
  });

  it('mean', () => {
    expect(mean([1, 2, 3])).toBe(2);
    expect(mean([])).toBe(0);
  });
});
