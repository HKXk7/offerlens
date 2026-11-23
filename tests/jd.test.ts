import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  JdArgsError,
  parseJdAddArgs,
} from '../src/jd/add-args.js';
import {
  computeCoverage,
  displayWidth,
  padDisplay,
} from '../src/jd/coverage.js';
import {
  JdConflictError,
  hashContent,
  nextJdId,
  normalizeRaw,
  upsertJd,
  validateJd,
} from '../src/jd/store.js';
import type { Jd } from '../src/schema/case.js';

const ROOT = resolve(import.meta.dirname, '..');

function mkJd(over: Partial<Jd> = {}): Jd {
  return {
    id: 'jd-app-01',
    title: '测试岗位',
    company_type: '测试公司',
    category: 'app',
    level: 'junior',
    source: 'synthetic',
    raw: '岗位职责：负责前端开发。任职要求：本科及以上学历，熟悉 TypeScript 与 React。',
    hard_req: ['本科及以上', 'TypeScript'],
    soft_req: ['有开源项目经验'],
    ...over,
  };
}

/* ------------------------------------------------------------------ */
/* 规范化与指纹                                                        */
/* ------------------------------------------------------------------ */

describe('normalizeRaw', () => {
  it('CRLF 与 LF 归一成同一种文本', () => {
    expect(normalizeRaw('第一行\r\n第二行')).toBe('第一行\n第二行');
    expect(normalizeRaw('第一行\n第二行')).toBe('第一行\n第二行');
  });

  it('去掉行尾空白但保留后续行的行首缩进', () => {
    // 行首缩进在 JD 里可能是有意义的层级信息，不能整篇吃掉。
    // 注意第一行的行首缩进会被最后的整体 trim 带走 —— 这是刻意的：
    // 整体 trim 用来去掉首尾空行，而 JD 第一行几乎总是标题，缩进无意义。
    expect(normalizeRaw('1. 要求一   \n  2. 要求二\t')).toBe('1. 要求一\n  2. 要求二');
  });

  it('整体首尾空白与空行被去掉', () => {
    expect(normalizeRaw('\n\n  岗位职责  \n\n')).toBe('岗位职责');
  });

  it('连续空行折成一行', () => {
    expect(normalizeRaw('A\n\n\n\nB')).toBe('A\n\nB');
  });
});

describe('hashContent', () => {
  it('同一内容换个换行方式，指纹相同', () => {
    // 这是去重成立的前提：从网页复制两次，行尾几乎不可能完全一致
    const a = hashContent('岗位职责：写代码\r\n任职要求：会写代码');
    const b = hashContent('岗位职责：写代码\n任职要求：会写代码');
    expect(a).toBe(b);
  });

  it('内容改一个字，指纹就变', () => {
    expect(hashContent('要求 TypeScript')).not.toBe(hashContent('要求 JavaScript'));
  });

  it('指纹固定 12 位十六进制', () => {
    expect(hashContent('任意内容')).toMatch(/^[0-9a-f]{12}$/);
  });

  it('不吞掉水印噪声：kanzhun 与原始文本指纹不同', () => {
    // 清洗要在下游显式做并留痕，而不是在 hash 阶段悄悄抹掉
    expect(hashContent('职位描述：写代码')).not.toBe(hashContent('职kanzhun位描述：写代码'));
  });
});

/* ------------------------------------------------------------------ */
/* id 生成与校验                                                        */
/* ------------------------------------------------------------------ */

describe('nextJdId', () => {
  it('按同前缀最大序号 +1', () => {
    const existing = [mkJd({ id: 'jd-app-01' }), mkJd({ id: 'jd-app-07' })];
    expect(nextJdId(existing, 'app', 'synthetic')).toBe('jd-app-08');
  });

  it('真实 JD 用独立前缀，不与合成数据抢序号', () => {
    const existing = [mkJd({ id: 'jd-app-03' })];
    expect(nextJdId(existing, 'app', 'real')).toBe('jd-real-app-01');
  });

  it('序号补两位，保证 id 可排序', () => {
    expect(nextJdId([], 'data', 'real')).toBe('jd-real-data-01');
  });
});

describe('validateJd', () => {
  it('合法条目通过', () => {
    expect(validateJd(mkJd())).toEqual([]);
  });

  it('source=real 缺 provenance 或 collected_at 时必须报错', () => {
    // 少了这两项，"真实"就只是一句无法核验的自我声明
    const errs = validateJd(mkJd({ source: 'real' }));
    expect(errs.join()).toContain('provenance');
    expect(errs.join()).toContain('collected_at');
  });

  it('source=real 带齐字段则通过', () => {
    const errs = validateJd(
      mkJd({
        source: 'real',
        provenance: 'manual-paste',
        collected_at: '2026-11-23T04:00:00Z',
        source_url: 'https://example.com/job/1',
      }),
    );
    expect(errs).toEqual([]);
  });

  it('collected_at 不是 ISO 格式要报错', () => {
    const errs = validateJd(
      mkJd({ source: 'real', provenance: 'search-curated', collected_at: '11月23日' }),
    );
    expect(errs.join()).toContain('ISO 8601');
  });

  it('synthetic 不应带 provenance', () => {
    const errs = validateJd(mkJd({ provenance: 'manual-paste' }));
    expect(errs.join()).toContain('synthetic');
  });

  it('raw 过短视为只粘了标题', () => {
    expect(validateJd(mkJd({ raw: '前端工程师' })).join()).toContain('短于 40 字');
  });

  it('枚举值拼错要报错', () => {
    const errs = validateJd(mkJd({ category: 'frontend' as never }));
    expect(errs.join()).toContain('category');
  });

  it('hard_req 里的空字符串要报错', () => {
    expect(validateJd(mkJd({ hard_req: ['本科及以上', ' '] })).join()).toContain('空字符串');
  });
});

/* ------------------------------------------------------------------ */
/* 写入与去重                                                          */
/* ------------------------------------------------------------------ */

describe('upsertJd', () => {
  const hash = hashContent('内容 A');
  const a = mkJd({ id: 'jd-app-01', content_hash: hash });

  it('新 id 直接追加', () => {
    const b = mkJd({ id: 'jd-app-02', content_hash: hashContent('内容 B') });
    const r = upsertJd([a], b);
    expect(r.action).toBe('inserted');
    expect(r.jds).toHaveLength(2);
  });

  it('同内容换 id 视为重复，不写入', () => {
    // 手滑跑两次 jd:add 是常见误操作，只有内容指纹能拦住
    const dup = mkJd({ id: 'jd-app-99', content_hash: hash });
    const r = upsertJd([a], dup);
    expect(r.action).toBe('duplicate');
    expect(r.duplicateOf).toBe('jd-app-01');
    expect(r.jds).toHaveLength(1);
  });

  it('同 id 不同内容默认抛错，而不是静默覆盖', () => {
    const changed = mkJd({ id: 'jd-app-01', content_hash: hashContent('内容改了') });
    expect(() => upsertJd([a], changed)).toThrow(JdConflictError);
  });

  it('显式 force 才允许覆盖', () => {
    const changed = mkJd({ id: 'jd-app-01', content_hash: hashContent('内容改了') });
    const r = upsertJd([a], changed, { force: true });
    expect(r.action).toBe('replaced');
    expect(r.jds[0]?.content_hash).toBe(hashContent('内容改了'));
  });

  it('不修改传入的数组（纯函数）', () => {
    const input = [a];
    upsertJd(input, mkJd({ id: 'jd-app-02', content_hash: hashContent('内容 B') }));
    expect(input).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ */
/* 覆盖度                                                              */
/* ------------------------------------------------------------------ */

describe('computeCoverage', () => {
  it('按 category × level 计数并找出缺格', () => {
    const jds = [
      mkJd({ id: 'jd-app-01', category: 'app', level: 'intern' }),
      mkJd({ id: 'jd-app-02', category: 'app', level: 'senior' }),
      mkJd({ id: 'jd-data-01', category: 'data', level: 'junior' }),
    ];
    const c = computeCoverage(jds);
    expect(c.total).toBe(3);
    expect(c.matrix.app.intern).toBe(1);
    expect(c.matrix.app.junior).toBe(0);
    expect(c.matrix.data.junior).toBe(1);
    // 4 类 × 3 档 = 12 格，只填了 3 格
    expect(c.gaps).toHaveLength(9);
    expect(c.gaps).toContainEqual({ category: 'business', level: 'senior' });
  });

  it('合成与真实分开统计，绝不合并', () => {
    const jds = [
      mkJd({ id: 'jd-app-01', source: 'synthetic', raw: '短'.repeat(38) }),
      mkJd({
        id: 'jd-real-app-01',
        source: 'real',
        provenance: 'search-curated',
        collected_at: '2026-11-23T04:00:00Z',
        raw: '长'.repeat(400),
      }),
    ];
    const c = computeCoverage(jds);
    expect(c.bySource.synthetic.count).toBe(1);
    expect(c.bySource.real.count).toBe(1);
    expect(c.bySource.synthetic.avgRawLength).toBe(38);
    expect(c.bySource.real.avgRawLength).toBe(400);
  });

  it('同一 content_hash 出现两次会被列为重复', () => {
    const h = hashContent('同一份内容');
    const jds = [
      mkJd({ id: 'jd-app-01', content_hash: h }),
      mkJd({ id: 'jd-app-02', content_hash: h }),
    ];
    const c = computeCoverage(jds);
    expect(c.duplicates).toHaveLength(1);
    expect(c.duplicates[0]?.ids).toEqual(['jd-app-01', 'jd-app-02']);
  });

  it('real 缺来源标注会被单独计数', () => {
    const jds = [mkJd({ id: 'jd-real-app-01', source: 'real', content_hash: hashContent('x') })];
    expect(computeCoverage(jds).bySource.real.missingProvenance).toBe(1);
  });

  it('空库不崩，且指出覆盖为 0', () => {
    const c = computeCoverage([]);
    expect(c.total).toBe(0);
    expect(c.gaps).toHaveLength(12);
    expect(c.bySource.real.count).toBe(0);
  });
});

describe('终端宽度对齐', () => {
  it('中文按 2 列计算', () => {
    expect(displayWidth('中文')).toBe(4);
    expect(displayWidth('ab')).toBe(2);
    expect(displayWidth('中a')).toBe(3);
  });

  it('padDisplay 让中文与英文列对齐', () => {
    // padEnd 会认为"中文"已占 6 列而不再补空格，实际只占 4 列，表格就歪了
    expect(displayWidth(padDisplay('中文', 10))).toBe(10);
    expect(displayWidth(padDisplay('abcdef', 10))).toBe(10);
  });
});

/* ------------------------------------------------------------------ */
/* 命令行参数                                                          */
/* ------------------------------------------------------------------ */

describe('parseJdAddArgs', () => {
  // 一份完整的"真实 JD"参数。source 默认 real，所以 provenance 与 url 是必填的一部分，
  // 少写任一都会被拦下 —— 这正是下面几条测试要验证的行为。
  const base = [
    '--file', 'a.txt',
    '--title', '岗位',
    '--hard-req', '本科',
    '--provenance', 'manual-paste',
    '--url', 'https://example.com/job/1',
  ];

  it('最小合法参数可以解析', () => {
    const a = parseJdAddArgs(base);
    expect(a.file).toBe('a.txt');
    expect(a.hardReq).toEqual(['本科']);
    expect(a.source).toBe('real');
    expect(a.provenance).toBe('manual-paste');
  });

  it('真实 JD 缺 --provenance 直接报错', () => {
    const argv = ['--file', 'a.txt', '--title', '岗位', '--hard-req', '本科', '--url', 'https://x'];
    expect(() => parseJdAddArgs(argv)).toThrow(JdArgsError);
    expect(() => parseJdAddArgs(argv)).toThrow(/provenance/);
  });

  it('真实 JD 缺 --url 直接报错', () => {
    const argv = ['--file', 'a.txt', '--title', '岗位', '--hard-req', '本科', '--provenance', 'manual-paste'];
    expect(() => parseJdAddArgs(argv)).toThrow(/--url/);
  });

  it('合成 JD 不需要 provenance 与 url', () => {
    const argv = ['--file', 'a.txt', '--title', '岗位', '--hard-req', '本科', '--source', 'synthetic'];
    const a = parseJdAddArgs(argv);
    expect(a.source).toBe('synthetic');
    expect(a.provenance).toBeNull();
  });

  it('hard_req 既不填也不声明无门槛时报错', () => {
    // 空 hard_req 会让 gate 指标恒为 0，看起来"模型很差"，其实是没标注
    expect(() => parseJdAddArgs(['--file', 'a.txt', '--title', '岗位'])).toThrow(/--hard-req/);
  });

  it('--no-hard-req 显式声明后允许为空', () => {
    // 注意这里刻意**不带** --hard-req：两者互斥，带了就变成另一条测试验证的行为
    const a = parseJdAddArgs([
      '--file', 'a.txt',
      '--title', '岗位',
      '--no-hard-req',
      '--provenance', 'manual-paste',
      '--url', 'https://x',
    ]);
    expect(a.hardReq).toEqual([]);
    expect(a.noHardReq).toBe(true);
  });

  it('--hard-req 与 --no-hard-req 互斥', () => {
    expect(() => parseJdAddArgs([...base, '--no-hard-req'])).toThrow(/不能同时用/);
  });

  it('枚举拼错要报错并列出合法值', () => {
    expect(() => parseJdAddArgs([...base, '--category', '前端'])).toThrow(/app \| platform/);
  });

  it('逗号分隔支持中英文标点', () => {
    const a = parseJdAddArgs([
      '--file', 'a.txt',
      '--title', '岗位',
      '--provenance', 'manual-paste',
      '--url', 'https://x',
      '--hard-req', '本科，TypeScript、React',
    ]);
    expect(a.hardReq).toEqual(['本科', 'TypeScript', 'React']);
  });

  it('--collected-at 不是 ISO 格式要报错', () => {
    expect(() => parseJdAddArgs([...base, '--collected-at', '昨天'])).toThrow(/ISO 8601/);
  });
});

/* ------------------------------------------------------------------ */
/* 仓库里的真实数据必须自洽                                            */
/* ------------------------------------------------------------------ */

describe('data/jd/jds.json 自洽性', () => {
  const jds = JSON.parse(readFileSync(resolve(ROOT, 'data/jd/jds.json'), 'utf8')) as Jd[];

  it('每条 JD 都通过校验', () => {
    const bad = jds.flatMap((jd) => validateJd(jd).map((e) => `${jd.id}: ${e}`));
    expect(bad).toEqual([]);
  });

  it('content_hash 与 raw 一致（防止手改正文却没更新指纹）', () => {
    const mismatched = jds.filter((jd) => jd.content_hash !== hashContent(jd.raw)).map((jd) => jd.id);
    expect(mismatched).toEqual([]);
  });

  it('id 唯一', () => {
    const ids = jds.map((jd) => jd.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('内容无重复（同一岗位不应导入两次）', () => {
    const dup = computeCoverage(jds).duplicates;
    expect(dup).toEqual([]);
  });

  it('真实样本都标了 provenance 与采集时间', () => {
    const real = jds.filter((jd) => jd.source === 'real');
    expect(real.length).toBeGreaterThan(0);
    expect(real.filter((jd) => !jd.provenance || !jd.collected_at)).toEqual([]);
  });

  it('真实 JD 平均长度显著长于合成 JD', () => {
    // 这是"合成数据过于干净"的量化证据，也是库里最有说服力的一个对比
    const c = computeCoverage(jds);
    const ratio = c.bySource.real.avgRawLength / c.bySource.synthetic.avgRawLength;
    expect(ratio).toBeGreaterThan(1.5);
  });
});
