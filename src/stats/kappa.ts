/**
 * Cohen's kappa：两个人对同一批样本做标注时的一致性。
 *
 * κ = (Po - Pe) / (1 - Pe)
 *   Po = 观察一致率
 *   Pe = 偶然一致率的期望
 *
 * 为什么不用"一致率 85%"这种说法：百分比一致率不含"瞎蒙也能蒙对"的部分。
 * 如果 90% 的样本都落在同一个类别，随手全标这一类就有 90% 一致率，但毫无信息量。
 * κ 把 Pe 减掉，所以更可信。
 *
 * 在本项目里的用途（策划书 3.3）：校验 rubric 写得清不清楚。
 * κ < 0.6 就说明两个人都读不懂同一份 rubric，得回去改 rubric——
 * 这个数字不是简历亮点，是内部质检工具。
 */

export interface KappaResult {
  n: number;
  observed: number;
  expected: number;
  kappa: number;
  labels: string[];
  /** 每个标签上的一致性（便于定位到底是哪个标签有歧义） */
  perLabel: Array<{ label: string; aCount: number; bCount: number; agree: number }>;
}

export function cohenKappa(
  a: readonly (string | number | boolean | null)[],
  b: readonly (string | number | boolean | null)[],
): KappaResult {
  if (a.length !== b.length) {
    throw new Error(`标注样本长度不一致：${a.length} vs ${b.length}`);
  }
  const n = a.length;
  if (n === 0) throw new Error('标注样本为空');

  const key = (v: string | number | boolean | null) => (v === null ? '__null__' : String(v));
  const countA = new Map<string, number>();
  const countB = new Map<string, number>();
  const labels = new Set<string>();
  let agree = 0;

  for (let i = 0; i < n; i++) {
    const ka = key(a[i]);
    const kb = key(b[i]);
    labels.add(ka);
    labels.add(kb);
    countA.set(ka, (countA.get(ka) ?? 0) + 1);
    countB.set(kb, (countB.get(kb) ?? 0) + 1);
    if (ka === kb) agree++;
  }

  const observed = agree / n;
  let expected = 0;
  const perLabel: KappaResult['perLabel'] = [];
  for (const label of [...labels].sort()) {
    const ca = countA.get(label) ?? 0;
    const cb = countB.get(label) ?? 0;
    expected += (ca / n) * (cb / n);
    let agreeOnLabel = 0;
    for (let i = 0; i < n; i++) if (key(a[i]) === label && key(b[i]) === label) agreeOnLabel++;
    perLabel.push({ label, aCount: ca, bCount: cb, agree: agreeOnLabel });
  }

  // Pe 到 1 说明两边都只用一个类别，κ 无定义（分母为 0），约定为 0
  const kappa = expected >= 1 ? 0 : (observed - expected) / (1 - expected);

  return { n, observed, expected, kappa, labels: [...labels].sort(), perLabel };
}

export function interpretKappa(kappa: number): string {
  if (kappa < 0) return '比随机还差，rubric 有问题';
  if (kappa < 0.2) return '几乎不一致（Landis & Koch: slight）';
  if (kappa < 0.4) return '一般（fair）——必须改 rubric';
  if (kappa < 0.6) return '中等（moderate）——建议改 rubric 再重标';
  if (kappa < 0.8) return '较好（substantial）';
  return '很好（almost perfect）';
}
