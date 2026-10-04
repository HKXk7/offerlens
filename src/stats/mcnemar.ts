import { binomialCdf, chiSquareSf1 } from './distributions.js';

export interface McNemarOptions {
  alpha?: number;
  /** 不传时按 b + c < 25 自动选精确法 */
  useExact?: boolean;
  /** 连续性校正（耶茨校正），只在卡方近似下生效 */
  continuityCorrection?: boolean;
}

export interface McNemarResult {
  /** 基线对、候选错 */
  b: number;
  /** 基线错、候选对 */
  c: number;
  /** b + c，即"翻转"的样本数。两边都对/都错的 case 不提供信息，不参与检验 */
  n: number;
  statistic: number;
  p: number;
  alpha: number;
  significant: boolean;
  method: 'exact-binomial' | 'chi-square';
  direction: 'better' | 'worse' | 'same';
}

function exactMcNemarP(b: number, c: number): number {
  const n = b + c;
  if (n === 0) return 1;
  const k = Math.min(b, c);
  return Math.min(1, 2 * binomialCdf(n, k, 0.5));
}

export function mcnemar(b: number, c: number, opts: McNemarOptions = {}): McNemarResult {
  const alpha = opts.alpha ?? 0.05;
  const useExact = opts.useExact ?? b + c < 25;
  const cc = opts.continuityCorrection ?? true;

  if (!Number.isInteger(b) || !Number.isInteger(c) || b < 0 || c < 0) {
    throw new Error(`mcnemar 需要非负整数 b、c，收到 b=${b} c=${c}`);
  }

  const n = b + c;
  let statistic = 0;
  let p = 1;
  const method: McNemarResult['method'] = useExact ? 'exact-binomial' : 'chi-square';

  if (useExact) {
    p = exactMcNemarP(b, c);
  } else if (n === 0) {
    statistic = 0;
    p = 1;
  } else {
    const delta = Math.abs(b - c) - (cc ? 1 : 0);
    statistic = delta <= 0 ? 0 : (delta * delta) / n;
    p = chiSquareSf1(statistic);
  }

  // b 多 = 候选把基线做对的题做错了 → 更差；c 多 = 候选救回了基线的错题 → 更好
  const direction: McNemarResult['direction'] = b === c ? 'same' : c > b ? 'better' : 'worse';

  return { b, c, n, statistic, p, alpha, significant: p < alpha, method, direction };
}

export function mcnemarFromPairs(
  basePassed: readonly boolean[],
  candPassed: readonly boolean[],
  opts: McNemarOptions = {},
): McNemarResult {
  if (basePassed.length !== candPassed.length) {
    throw new Error(`配对样本长度不一致：${basePassed.length} vs ${candPassed.length}`);
  }
  let b = 0;
  let c = 0;
  for (let i = 0; i < basePassed.length; i++) {
    if (basePassed[i] && !candPassed[i]) b++;
    else if (!basePassed[i] && candPassed[i]) c++;
  }
  return mcnemar(b, c, opts);
}
