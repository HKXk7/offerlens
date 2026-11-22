/**
 * 评测运行器（src/eval/runner.ts）的前置逻辑测试。
 *
 * 这块是整个项目里最大的一份代码（近千行），却被「必须花钱 + 必须联网」挡住了单测 ——
 * 结果就是最容易出错的**入口校验**和**字段解析**长期没有回归保护。
 * 这里绕开网络：只测「不起请求的那些分支」。
 *
 * 三个真正值得守的点：
 *   1. 参数校验要在**产生任何费用之前**抛错（否则一个 `--runs 0` 就能跑到结尾才发现白跑）
 *   2. 档位过滤失败时，错误信息必须列出可选值（否则用户只能去翻代码）
 *   3. dry-run 必须在没 key 的情况下也能跑通 —— 这是「花钱前先看 prompt」这条承诺的前提
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EvalError, runEval, type EvalEvent } from '../src/eval/runner.js';

/** 与 src/agent/catalog.ts 里的 provider 一一对应：测试用的假 key，永远不会被发出去 */
const PROVIDER_KEYS = ['SILICONFLOW_API_KEY', 'DEEPSEEK_API_KEY', 'ZHIPU_API_KEY'] as const;

let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = {};
  for (const k of PROVIDER_KEYS) saved[k] = process.env[k];
});

afterEach(() => {
  for (const k of PROVIDER_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

/** 收集 emit 出来的所有事件，便于断言「打印了什么」 */
function collector(): { events: EvalEvent[]; text: () => string } {
  const events: EvalEvent[] = [];
  return {
    events,
    text: () =>
      events
        .filter((e): e is { type: 'log'; line: string } => e.type === 'log')
        .map((e) => e.line)
        .join('\n'),
  };
}

/** 让「手上一个 key 都没有」成立：空串在 catalog 里被 trim 后判为缺失 */
function clearAllKeys(): void {
  for (const k of PROVIDER_KEYS) process.env[k] = '';
}

describe('参数校验：必须在花钱之前失败', () => {
  const cases: Array<[string, Parameters<typeof runEval>[0]]> = [
    ['runs 为 0', { runs: 0 }],
    ['runs 为小数', { runs: 1.5 }],
    ['budget 为负数', { budget: -1 }],
    ['concurrency 为 0', { concurrency: 0 }],
    ['concurrency 为小数', { concurrency: 2.5 }],
    ['limit 为 0', { limit: 0 }],
    ['limit 为负数', { limit: -3 }],
  ];

  for (const [label, opts] of cases) {
    it(`${label} 时抛 EvalError（code=internal）`, async () => {
      await expect(runEval(opts, () => {})).rejects.toThrow(EvalError);
      await expect(runEval(opts, () => {})).rejects.toMatchObject({ code: 'internal' });
    });
  }

  it('校验失败时不会产生任何事件（连日志都不该有）', async () => {
    const { events } = collector();
    await expect(runEval({ runs: 0 }, () => {})).rejects.toThrow();
    expect(events).toHaveLength(0);
  });
});

describe('档位过滤', () => {
  it('不存在的档位 → no_profiles，且错误信息里列出所有可选档位', async () => {
    process.env.SILICONFLOW_API_KEY = 'sk-test-dummy';

    const err = await runEval({ profiles: ['这个档位不存在'], dryRun: true }, () => {}).catch(
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(EvalError);
    expect((err as EvalError).code).toBe('no_profiles');
    // 报错必须自解释：用户不该为了知道有哪些档位而去读源码
    expect((err as EvalError).message).toContain('sf-');
    expect((err as EvalError).message).toContain('/');
  });

  it('匹配到档位时按传入顺序之外仍取矩阵顺序，且不重复', async () => {
    process.env.SILICONFLOW_API_KEY = 'sk-test-dummy';

    const summary = await runEval(
      { profiles: ['sf-qwen35-122b__p2-strict', 'sf-dsv4flash__p2-strict'], dryRun: true },
      () => {},
    );

    expect(summary.profiles).toEqual(['sf-dsv4flash__p2-strict', 'sf-qwen35-122b__p2-strict']);
    expect(new Set(summary.profiles).size).toBe(summary.profiles.length);
  });
});

describe('dry-run：花钱前先看 prompt', () => {
  it('没配任何 key 也能跑通（这是预览功能存在的意义）', async () => {
    clearAllKeys();

    const summary = await runEval({ dryRun: true, judge: false }, () => {});

    expect(summary.totalRuns).toBe(0);
    expect(summary.spentCny).toBe(0);
  });

  it('返回结构完整：totalRuns=0、无报告文件、成本为 0', async () => {
    process.env.SILICONFLOW_API_KEY = 'sk-test-dummy';
    const summary = await runEval({ dryRun: true, judge: false }, () => {});

    expect(summary.totalRuns).toBe(0);
    expect(summary.reportPath).toBeNull();
    expect(summary.spentCny).toBe(0);
    expect(summary.genCostTotal).toBe(0);
    expect(summary.judgeCostTotal).toBe(0);
    expect(summary.failures).toBe(0);
    expect(summary.startedAt).toBeTypeOf('string');
    expect(summary.durationMs).toBe(0);
  });

  it('确实打印了要发出去的内容，并明确说明「不会真的发」', async () => {
    process.env.SILICONFLOW_API_KEY = 'sk-test-dummy';
    const { events, text } = collector();

    await runEval({ dryRun: true, judge: false, limit: 2 }, (e) => events.push(e));
    const logs = text();

    expect(logs).toContain('不会真的发');
    expect(logs).toContain('JD 原文');
    // 段 ID 是锚点的前提，预览里必须能看到
    expect(logs).toMatch(/S\d{2}/);
    expect(events.at(-1)?.type).toBe('done');
  });

  it('limit 生效：caseCount 跟随 limit，而不是永远 24', async () => {
    process.env.SILICONFLOW_API_KEY = 'sk-test-dummy';

    const two = await runEval({ dryRun: true, limit: 2 }, () => {});
    const all = await runEval({ dryRun: true }, () => {});

    expect(two.caseCount).toBe(2);
    expect(all.caseCount).toBe(24);
    expect(all.caseCount).toBeGreaterThan(two.caseCount);
  });

  it('固定种子下两次 dry-run 选中的是同一组 case（否则报告不可复现）', async () => {
    process.env.SILICONFLOW_API_KEY = 'sk-test-dummy';

    /** 只取「case 头 + 简历 + JD」这段：它由固定种子决定，必须逐字稳定 */
    const grab = async (): Promise<string> => {
      const lines: string[] = [];
      await runEval({ dryRun: true, limit: 3 }, (e) => {
        if (e.type === 'log') lines.push(e.line);
      });
      const all = lines.join('\n');
      const from = all.indexOf('--- case:');
      expect(from).toBeGreaterThanOrEqual(0);
      return all.slice(from);
    };

    // 注意不能比对整段日志：第一行「本次新加载了哪些环境变量」取决于进程先前状态
    // （loadEnv 会把 .env 写进 process.env，第二次调用自然是「无新键」）。
    // 那是运行环境的事实，不是可复现性的一部分。
    expect(await grab()).toBe(await grab());
  });
});

describe('缺 key：明确报 missing_key，而不是跑一半才崩', () => {
  it('非 dry-run 且一个 key 都没有 → missing_key，且提示去哪注册', async () => {
    clearAllKeys();

    const err = await runEval({ judge: false }, () => {}).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(EvalError);
    expect((err as EvalError).code).toBe('missing_key');
    // 报错要给出可执行的下一步：环境变量名 + 注册地址
    expect((err as EvalError).message).toMatch(/API_KEY/);
    expect((err as EvalError).message).toMatch(/https?:\/\//);
    expect((err as EvalError).message).toContain('.env');
  });
});
