/**
 * 固定种子随机数。
 *
 * 为什么必须用固定种子：评测集的抽样和 bootstrap 重采样只要有一点随机性，
 * 两次 run 的结论就不可比——而"可复现"是这个项目唯一值钱的东西。
 * 所以全项目禁止使用 Math.random()，一律走这里。
 *
 * 算法用 mulberry32：32 位种子、无依赖、速度快、分布对本用途足够。
 */

export interface Rng {
  /** 返回 [0, 1) */
  next(): number;
  /** 返回 [0, max) 的整数；max 必须 > 0 */
  int(max: number): number;
  /** 从数组里随机取一个（空数组会抛错） */
  pick<T>(arr: readonly T[]): T;
  /** 返回打乱后的新数组（不改动入参） */
  shuffle<T>(arr: readonly T[]): T[];
}

export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;

  const next = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const int = (max: number): number => {
    if (!Number.isInteger(max) || max <= 0) {
      throw new Error(`rng.int(max) 需要正整数 max，收到 ${max}`);
    }
    return Math.floor(next() * max);
  };

  const shuffle = <T,>(arr: readonly T[]): T[] => {
    const out = arr.slice();
    for (let i = out.length - 1; i > 0; i--) {
      const j = int(i + 1);
      const tmp = out[i];
      out[i] = out[j];
      out[j] = tmp;
    }
    return out;
  };

  return {
    next,
    int,
    pick: <T,>(arr: readonly T[]): T => {
      if (arr.length === 0) throw new Error('rng.pick 收到空数组');
      return arr[int(arr.length)];
    },
    shuffle,
  };
}

/** 把任意字符串转成稳定的 32 位种子（用于"按数据集版本号决定抽样"这种场景）。 */
export function seedFromString(input: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}
