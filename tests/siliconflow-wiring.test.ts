/**
 * 回归测试：**关思考参数必须真的进到请求体里**。
 *
 * 这一条是实测踩出来的，不是假想：
 *   硅基流动上 Qwen3.5 系列默认开思维链。给一句「只回复两个字」，
 *   Qwen3.5-122B-A10B 输出 4117 token（其中 reasoning 14325 字），
 *   Qwen3.5-9B 输出 3454 token。本项目一次诊断输出约 6000 token，
 *   思考 token 按输出价计费 —— 参数没生效 = 成本不可控。
 *
 * 而当时的代码是：catalog.ts 声明了 extraBody，
 * llm.ts 也写了 Object.assign(body, extraBody)，
 * **但 offerAgent 和 llmJudge 构造 LlmClient 时都没把它传进去**。
 * 声明与消费两端都在，中间断链，静态看完全正常。
 *
 * 所以这里不测"函数返回值"，而是**拦截真实请求体**断言 —— 只有这样才测得出来。
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  defaultJudge,
  familyOf,
  MODELS,
  SF_MAX_TOKENS,
  siliconflowProfiles,
} from '../src/agent/catalog.js';
import { OfferAgent } from '../src/agent/offerAgent.js';
import { judgeSuggestions } from '../src/agent/llmJudge.js';
import { buildCases } from '../scripts/build-cases.js';
import type { Jd, Resume } from '../src/schema/case.js';

const ROOT = resolve(__dirname, '..');
const jds = JSON.parse(readFileSync(resolve(ROOT, 'data/jd/jds.json'), 'utf8')) as Jd[];
const resumes = JSON.parse(readFileSync(resolve(ROOT, 'data/resumes/resumes.json'), 'utf8')) as Resume[];

/** 被拦截到的请求体 */
let captured: Array<Record<string, unknown>> = [];
const originalFetch = globalThis.fetch;

function stubFetch(jsonBody: string): void {
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    captured.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: jsonBody }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 100, completion_tokens: 20 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as typeof fetch;
}

beforeAll(() => {
  // 让 resolveApiKey / resolveJudgeKey 拿得到值；不联网，只是走通校验
  process.env.SILICONFLOW_API_KEY = 'sk-test-only';
  process.env.DEEPSEEK_API_KEY = 'sk-test-only';
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  captured = [];
  vi.restoreAllMocks();
});

describe('extraBody 真的进了请求体（会烧钱的断链）', () => {
  it('生成侧：Qwen3.5 必须带 enable_thinking:false', async () => {
    const { cases } = buildCases(resumes, jds, { seed: 20261004 });
    const c = cases[0];
    const resume = resumes.find((r) => r.id === c.resume_id)!;
    const jd = jds.find((j) => j.id === c.jd_id)!;

    stubFetch('{"broken":true}');
    const agent = new OfferAgent(MODELS['Qwen/Qwen3.5-122B-A10B'], 'p2-strict');
    // 第一次调用之后就会因为拿不到合法结构而失败 —— 没关系，
    // 这里要断言的是"请求体里到底有没有那个参数"，不是这次运行成不成功。
    await agent.run(c, resume, jd, 0).catch(() => undefined);

    expect(captured.length).toBeGreaterThan(0);
    expect(captured[0]).toMatchObject({ enable_thinking: false });
    expect(captured[0].model).toBe('Qwen/Qwen3.5-122B-A10B');
    // 输出上限也必须显式传：不给就落到服务端默认（硅基流动 4096），
    // 有的模型会在这里被截断，JSON 永远不完整 —— 看起来像模型不行。
    expect(captured[0].max_tokens).toBe(SF_MAX_TOKENS);
  });

  it('生成侧：GLM-4.5-Air 必须带 thinking:{type:"disabled"}', async () => {
    const { cases } = buildCases(resumes, jds, { seed: 20261004 });
    const c = cases[0];
    const resume = resumes.find((r) => r.id === c.resume_id)!;
    const jd = jds.find((j) => j.id === c.jd_id)!;

    stubFetch('{"broken":true}');
    const agent = new OfferAgent(MODELS['zai-org/GLM-4.5-Air'], 'p2-strict');
    await agent.run(c, resume, jd, 0).catch(() => undefined);

    expect(captured[0]).toMatchObject({ thinking: { type: 'disabled' } });
  });

  it('裁判侧：Hunyuan-A13B 也必须关思考', async () => {
    stubFetch('{"scores":[{"index":0,"score":3},{"index":1,"score":2}]}');
    const jr = await judgeSuggestions(MODELS['tencent/Hunyuan-A13B-Instruct'], ['建议一', '建议二']);

    expect(jr.error).toBeNull();
    expect(captured.length).toBeGreaterThan(0);
    for (const body of captured) expect(body).toMatchObject({ enable_thinking: false });
  });
});

describe('response_format 不支持时自动降级', () => {
  it('GLM-4.5-Air 实测会 400 Json mode is not supported —— 去掉该字段重试即可跑通', async () => {
    let calls = 0;
    globalThis.fetch = (async (_u: string | URL | Request, init?: RequestInit) => {
      captured.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
      calls++;
      if (calls === 1) {
        // 硅基流动的真实错误体
        return new Response(
          JSON.stringify({ code: 20024, message: 'Json mode is not supported for this model' }),
          { status: 400, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"scores":[{"index":0,"score":3}]}' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;

    const jr = await judgeSuggestions(MODELS['zai-org/GLM-4.5-Air'], ['只有一条建议']);

    expect(jr.error).toBeNull();
    expect(jr.scores).toEqual([3]);
    expect(captured).toHaveLength(2);
    // 第一次带 response_format，被拒后降级去掉，但关思考参数必须还在
    expect(captured[0].response_format).toEqual({ type: 'json_object' });
    expect(captured[1].response_format).toBeUndefined();
    expect(captured[1]).toMatchObject({ thinking: { type: 'disabled' } });
  });
});

describe('硅基流动矩阵的模型目录约束', () => {
  it('矩阵里每个档位的模型都必须声明 extraBody（否则成本不可控）', () => {
    for (const p of siliconflowProfiles()) {
      expect(p.model.extraBody, `${p.run_id} 缺 extraBody`).toBeDefined();
    }
  });

  it('每个档位的 run_id 与模型 id 不重复，基线是第一个', () => {
    const profiles = siliconflowProfiles();
    expect(new Set(profiles.map((p) => p.run_id)).size).toBe(profiles.length);
    expect(profiles[0].run_id).toBe('sf-dsv4flash__p2-strict');
  });

  it('priceInPerM/priceOutPerM 必须是真实的非负数字（分时段价要按贵的那档填）', () => {
    for (const p of siliconflowProfiles()) {
      expect(p.model.priceInPerM).toBeGreaterThan(0);
      expect(p.model.priceOutPerM).toBeGreaterThan(0);
    }
  });
});

describe('族判定与跨族裁判', () => {
  it('familyOf 按厂商正确归类', () => {
    expect(familyOf(MODELS['deepseek-ai/DeepSeek-V4-Flash'])).toBe('deepseek');
    expect(familyOf(MODELS['Qwen/Qwen3.5-122B-A10B'])).toBe('qwen');
    expect(familyOf(MODELS['Qwen/Qwen3.5-27B'])).toBe('qwen');
    expect(familyOf(MODELS['zai-org/GLM-4.5-Air'])).toBe('zhipu');
    expect(familyOf(MODELS['inclusionAI/Ling-flash-2.0'])).toBe('inclusionai');
    expect(familyOf(MODELS['tencent/Hunyuan-A13B-Instruct'])).toBe('tencent');
    // 老档位也要对，避免规则改动把 DeepSeek 矩阵的裁判判定带歪
    expect(familyOf(MODELS['deepseek-flash'])).toBe('deepseek');
    expect(familyOf(MODELS['glm-4.5-flash'])).toBe('zhipu');
  });

  it('有硅基流动 key 时，裁判选腾讯混元，且与矩阵里所有被测族都不同族', () => {
    const sel = defaultJudge();
    expect(sel.model.id).toBe('tencent/Hunyuan-A13B-Instruct');
    expect(sel.crossFamily).toBe(true);

    const underTest = new Set(siliconflowProfiles().map((p) => familyOf(p.model)));
    expect(underTest.has(familyOf(sel.model))).toBe(false);
  });

  it('裁判**不能**跟被测模型同族（这条以前是写死的，加 Qwen 档位后就错了）', () => {
    const underTest = new Set(siliconflowProfiles().map((p) => familyOf(p.model)));
    // 早期实现：有硅基流动 key 就用 Qwen3-8B 当裁判。
    // 矩阵里一旦出现 Qwen 档位，这就变成 Qwen 给 Qwen 打分。
    expect(underTest.has('qwen')).toBe(true);
    expect(familyOf(defaultJudge().model)).not.toBe('qwen');
  });
});
