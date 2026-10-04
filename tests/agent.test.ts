import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { extractJson } from '../src/agent/llm.js';
import { BudgetTracker, budgetExceeded } from '../src/lib/budget.js';
import { loadEnv } from '../src/lib/env.js';
import {
  costOf,
  formatPrice,
  MODELS,
  PROVIDERS,
  defaultJudge,
  defaultProfiles,
  deepseekProfiles,
} from '../src/agent/catalog.js';
import { renderResume } from '../src/agent/prompts.js';
import type { Resume } from '../src/schema/case.js';

describe('extractJson：把模型回复里的 JSON 抠出来', () => {
  it('纯 JSON 直接 parse', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
  });

  it('剥掉 ```json 围栏', () => {
    const raw = '```json\n{"suggestions":[{"text":"改 S01"}]}\n```';
    expect(extractJson<{ suggestions: unknown[] }>(raw).suggestions).toHaveLength(1);
  });

  it('剥掉没有语言标记的围栏', () => {
    expect(extractJson('```\n{"ok":true}\n```')).toEqual({ ok: true });
  });

  it('前后有自然语言时靠花括号配对定位', () => {
    const raw = '好的，以下是结果：\n{"score":3}\n希望对你有帮助！';
    expect(extractJson<{ score: number }>(raw).score).toBe(3);
  });

  it('字符串里含花括号时不能数错（正则会在这里挂掉）', () => {
    const raw = '{"text":"建议把 {占位符} 改成具体数字","n":2}';
    expect(extractJson<{ text: string; n: number }>(raw).n).toBe(2);
  });

  it('字符串里的转义引号不能提前结束扫描', () => {
    const raw = '前言 {"text":"他说\\"这里要量化\\"","n":1} 后记';
    expect(extractJson<{ n: number }>(raw).n).toBe(1);
  });

  it('数组开头也能抠出来', () => {
    expect(extractJson('[1,2,3]')).toEqual([1, 2, 3]);
  });

  it('找不到 JSON 时抛错，且错误里带原文片段便于排查', () => {
    expect(() => extractJson('这里完全没有 JSON')).toThrow(/找不到合法 JSON/);
  });

  it('多个 JSON 时取第一个', () => {
    expect(extractJson<{ a: number }>('{"a":1} 和 {"a":2}').a).toBe(1);
  });
});

describe('BudgetTracker：预算硬上限', () => {
  it('累加成本', () => {
    const b = new BudgetTracker(10);
    b.add(1.5);
    b.add(2.5);
    expect(b.spentCny).toBeCloseTo(4, 10);
    expect(b.remainingCny()).toBeCloseTo(6, 10);
    expect(budgetExceeded(b)).toBe(false);
  });

  it('越线后标记为已超支（不是刚好等于）', () => {
    const b = new BudgetTracker(5);
    b.add(5);
    expect(budgetExceeded(b)).toBe(false); // 正好花完不算超
    b.add(0.01);
    expect(budgetExceeded(b)).toBe(true);
  });

  it('免费模型全程记 0，永远不越线', () => {
    const b = new BudgetTracker(0);
    for (let i = 0; i < 100; i++) b.add(0);
    expect(budgetExceeded(b)).toBe(false);
    expect(b.spentCny).toBe(0);
  });

  it('负数与 NaN 被忽略，不会把余额刷高', () => {
    const b = new BudgetTracker(10);
    b.add(1);
    b.add(-100);
    b.add(Number.NaN);
    expect(b.spentCny).toBe(1);
  });

  it('非法上限直接抛错', () => {
    expect(() => new BudgetTracker(-1)).toThrow(/非负数/);
  });
});

describe('loadEnv：.env 解析', () => {
  afterEach(() => {
    for (const k of ['OLENS_TEST_A', 'OLENS_TEST_B', 'OLENS_TEST_C', 'OLENS_TEST_QUOTE', 'GOOD_NAME']) {
      delete process.env[k];
    }
  });

  function writeEnv(content: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'offerlens-env-'));
    const p = join(dir, '.env');
    writeFileSync(p, content, 'utf8');
    return p;
  }

  it('文件不存在时返回 found=false，不抛错', () => {
    const r = loadEnv(join(tmpdir(), 'offerlens-does-not-exist-12345.env'));
    expect(r.found).toBe(false);
    expect(r.loaded).toEqual([]);
  });

  it('解析 KEY=VALUE，忽略注释与空行', () => {
    const p = writeEnv('# 注释\n\nOLENS_TEST_A=hello\n  \nOLENS_TEST_B = world \n');
    const r = loadEnv(p);
    expect(process.env['OLENS_TEST_A']).toBe('hello');
    expect(process.env['OLENS_TEST_B']).toBe('world');
    expect(r.loaded.sort()).toEqual(['OLENS_TEST_A', 'OLENS_TEST_B']);
  });

  it('去掉包裹的引号', () => {
    const p = writeEnv('OLENS_TEST_QUOTE="sk-abc123"');
    loadEnv(p);
    expect(process.env['OLENS_TEST_QUOTE']).toBe('sk-abc123');
  });

  it('已存在的环境变量不被文件覆盖（CI 注入的凭证优先级更高）', () => {
    process.env['OLENS_TEST_C'] = 'from-ci';
    const p = writeEnv('OLENS_TEST_C=from-file');
    const r = loadEnv(p);
    expect(process.env['OLENS_TEST_C']).toBe('from-ci');
    expect(r.loaded).not.toContain('OLENS_TEST_C');
  });

  it('非法的键名被跳过', () => {
    const p = writeEnv('123BAD=x\n=empty\nGOOD_NAME=1\n');
    const r = loadEnv(p);
    expect(r.loaded).not.toContain('123BAD');
    expect(r.loaded).toContain('GOOD_NAME');
  });
});

describe('catalog：成本与档位', () => {
  it('免费模型成本恒为 0', () => {
    expect(costOf(MODELS['glm-4.5-flash'], 1_000_000, 500_000)).toBe(0);
  });

  it('按百万 token 计价（缓存未命中）', () => {
    // deepseek-flash 峰时折算价：¥2.16/百万 in、¥8.64/百万 out
    expect(costOf(MODELS['deepseek-flash'], 500_000, 250_000)).toBeCloseTo(1.08 + 2.16, 10);
  });

  it('缓存命中的输入单独按低价计费，不能被一律当成未命中', () => {
    // 500k 全命中 → 500k/1e6 × ¥0.043 = ¥0.0215；输出 250k × ¥8.64/1e6 = ¥2.16
    expect(costOf(MODELS['deepseek-flash'], 500_000, 250_000, 500_000)).toBeCloseTo(0.0215 + 2.16, 6);
    // 命中数超过输入总数时按输入总数夹紧，不能算出负的未命中量（那会得出负成本）
    expect(costOf(MODELS['deepseek-flash'], 500_000, 0, 999_999)).toBeCloseTo(0.0215, 6);
  });

  it('免费档显示为"免费"', () => {
    expect(formatPrice(MODELS['glm-4.7-flash'])).toBe('免费');
  });

  it('估算价带 ≈ 标记，避免把估的价当官方价', () => {
    expect(formatPrice(MODELS['glm-4-plus'])).toContain('≈');
    expect(formatPrice(MODELS['deepseek-flash'])).toContain('≈');
  });

  it('DeepSeek 两个模型都必须显式关掉思考模式', () => {
    // 默认 thinking=enabled：思考 token 按输出价计费，且正文会被 max_tokens 截断导致 JSON 解析失败
    expect(MODELS['deepseek-flash'].extraBody).toEqual({ thinking: { type: 'disabled' } });
    expect(MODELS['deepseek-v4-pro'].extraBody).toEqual({ thinking: { type: 'disabled' } });
  });

  it('智谱矩阵只改一个变量：同 prompt 换模型，同模型换 prompt', () => {
    // 显式清掉 DeepSeek key，否则 defaultProfiles() 会切到 DeepSeek 矩阵
    const savedDs = process.env['DEEPSEEK_API_KEY'];
    delete process.env['DEEPSEEK_API_KEY'];
    try {
      const profiles = defaultProfiles();
      expect(profiles).toHaveLength(3);
      // 档位 1、2 同为 p1-baseline，只有模型不同 → 回答"换模型有用吗"
      expect(profiles[0].prompt_version).toBe('p1-baseline');
      expect(profiles[1].prompt_version).toBe('p1-baseline');
      expect(profiles[0].model.id).not.toBe(profiles[1].model.id);
      // 档位 1、3 同为 glm-4.5-flash，只有 prompt 不同 → 回答"改 prompt 有用吗"
      expect(profiles[2].model.id).toBe(profiles[0].model.id);
      expect(profiles[2].prompt_version).not.toBe(profiles[0].prompt_version);
    } finally {
      if (savedDs !== undefined) process.env['DEEPSEEK_API_KEY'] = savedDs;
    }
  });

  it('只有 DeepSeek key 时自动切到 DeepSeek 矩阵，且仍是单变量设计', () => {
    const saved = process.env['DEEPSEEK_API_KEY'];
    const savedZhipu = process.env['ZHIPU_API_KEY'];
    delete process.env['ZHIPU_API_KEY'];
    process.env['DEEPSEEK_API_KEY'] = 'test-key';
    try {
      expect(defaultProfiles()).toEqual(deepseekProfiles());
      const p = deepseekProfiles();
      // 1、2 同模型不同 prompt ⇒ 隔离出 prompt 的贡献
      expect(p[0].model.id).toBe('deepseek-flash');
      expect(p[1].model.id).toBe('deepseek-flash');
      expect(p[1].prompt_version).not.toBe(p[0].prompt_version);
      // 1、3 同 prompt 不同模型 ⇒ 隔离出模型的贡献
      expect(p[2].prompt_version).toBe(p[0].prompt_version);
      expect(p[2].model.id).not.toBe(p[0].model.id);
    } finally {
      if (saved === undefined) delete process.env['DEEPSEEK_API_KEY'];
      else process.env['DEEPSEEK_API_KEY'] = saved;
      if (savedZhipu !== undefined) process.env['ZHIPU_API_KEY'] = savedZhipu;
    }
  });

  it('裁判选择：只有 DeepSeek 时用不同模型但同族，并如实标记为不跨族', () => {
    const savedZhipu = process.env['ZHIPU_API_KEY'];
    const savedSf = process.env['SILICONFLOW_API_KEY'];
    const savedDs = process.env['DEEPSEEK_API_KEY'];
    delete process.env['ZHIPU_API_KEY'];
    delete process.env['SILICONFLOW_API_KEY'];
    process.env['DEEPSEEK_API_KEY'] = 'test-key';
    try {
      const j1 = defaultJudge();
      expect(j1.model.id).toBe('deepseek-v4-pro');
      expect(j1.crossFamily).toBe(false); // 必须如实暴露，不能默默当跨族用
      // 有硅基流动 key 时应优先跨族
      process.env['SILICONFLOW_API_KEY'] = 'test-key';
      const j2 = defaultJudge();
      expect(j2.crossFamily).toBe(true);
    } finally {
      if (savedZhipu !== undefined) process.env['ZHIPU_API_KEY'] = savedZhipu;
      if (savedSf === undefined) delete process.env['SILICONFLOW_API_KEY'];
      else process.env['SILICONFLOW_API_KEY'] = savedSf;
      if (savedDs === undefined) delete process.env['DEEPSEEK_API_KEY'];
      else process.env['DEEPSEEK_API_KEY'] = savedDs;
    }
  });

  it('智谱 base url 保留结尾斜杠（少了它接口 404）', () => {
    expect(PROVIDERS.zhipu.baseUrl.endsWith('/')).toBe(true);
  });
});

describe('prompts：简历渲染', () => {
  const resume: Resume = {
    id: 'r1',
    anon_id: 'R-01',
    headline: '前端实习',
    experience_level: 'rich',
    major_related: true,
    segments: [
      { seg_id: 'S01', text: '第一段' },
      { seg_id: 'S02', text: '第二段' },
    ],
    skills: ['React', 'TypeScript'],
    internships: [],
    projects: [],
  };

  it('每个段 ID 都必须原样出现 —— 少了模型就没法回填锚点', () => {
    const text = renderResume(resume);
    expect(text).toContain('[S01]');
    expect(text).toContain('[S02]');
    expect(text).toContain('第一段');
  });

  it('技能列表被渲染进去，否则模型会以为简历没写技能', () => {
    expect(renderResume(resume)).toContain('React');
  });
});
