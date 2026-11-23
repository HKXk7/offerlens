import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCases } from '../scripts/build-cases.js';
import { JOB_CATEGORIES, type Jd, type Resume } from '../src/schema/case.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const allJds = JSON.parse(readFileSync(resolve(ROOT, 'data/jd/jds.json'), 'utf8')) as Jd[];
// 与 scripts/build-cases.ts 的默认行为保持一致：只拿合成 JD 组装固定评测集。
// 真实 JD 进池需要显式 --include-real，单独有一条测试守它。
const jds = allJds.filter((j) => j.source === 'synthetic');
const resumes = JSON.parse(readFileSync(resolve(ROOT, 'data/resumes/resumes.json'), 'utf8')) as Resume[];

describe('评测集组装', () => {
  it('同一种子必须产出完全一致的评测集（否则两次 run 的结论不可比）', () => {
    const a = buildCases(resumes, jds, { seed: 20261004 });
    const b = buildCases(resumes, jds, { seed: 20261004 });
    expect(a.cases).toEqual(b.cases);
    expect(a.dataset.version).toBe(b.dataset.version);
  });

  it('换种子会得到不同的一批 case', () => {
    const a = buildCases(resumes, jds, { seed: 20261004 });
    const b = buildCases(resumes, jds, { seed: 1 });
    expect(a.cases.map((c) => c.id)).not.toEqual(b.cases.map((c) => c.id));
  });

  it('规模：4 简历 × 6 = 24 组，每份简历都出现', () => {
    const { cases } = buildCases(resumes, jds, { seed: 20261004 });
    expect(cases).toHaveLength(24);
    for (const r of resumes) {
      expect(cases.filter((c) => c.resume_id === r.id)).toHaveLength(6);
    }
  });

  it('每份简历都覆盖全部 4 个岗位类别（否则切片下钻会缺格）', () => {
    const { cases } = buildCases(resumes, jds, { seed: 20261004 });
    for (const r of resumes) {
      const cats = new Set(cases.filter((c) => c.resume_id === r.id).map((c) => c.tags.category));
      expect([...cats].sort()).toEqual([...JOB_CATEGORIES].sort());
    }
  });

  it('4 组 golden + 4 组 hard negative', () => {
    const { cases, hardNegativeReasons } = buildCases(resumes, jds, { seed: 20261004 });
    expect(cases.filter((c) => c.is_golden)).toHaveLength(4);
    expect(cases.filter((c) => c.is_hard_negative)).toHaveLength(4);
    // golden 和 hard negative 不能是同一组
    for (const c of cases) expect(c.is_golden && c.is_hard_negative).toBe(false);
    // 每个难例都要有人能看懂的理由
    for (const c of cases.filter((x) => x.is_hard_negative)) {
      expect(hardNegativeReasons[c.id]).toBeTruthy();
    }
  });

  it('每份简历恰好有 1 组 golden', () => {
    const { cases } = buildCases(resumes, jds, { seed: 20261004 });
    for (const r of resumes) {
      expect(cases.filter((c) => c.resume_id === r.id && c.is_golden)).toHaveLength(1);
    }
  });

  it('case id 唯一', () => {
    const { cases } = buildCases(resumes, jds, { seed: 20261004 });
    expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length);
  });

  it('评测集数据本身：12 个合成 JD、4 份简历、每类岗位 3 个', () => {
    // 断言的是「合成部分的构成」，不是 jds.json 的总条数 ——
    // 真实 JD 会随采集不断增加，把总条数写死会让每加一条 JD 都要改测试，
    // 而那恰恰是测试在阻止正常的数据积累。
    expect(jds).toHaveLength(12);
    expect(resumes).toHaveLength(4);
    for (const c of JOB_CATEGORIES) {
      expect(jds.filter((j) => j.category === c)).toHaveLength(3);
    }
    // 4 种经历丰厚度各一份 —— 切片下钻要按它切
    expect(new Set(resumes.map((r) => r.experience_level)).size).toBe(4);
  });

  it('真实 JD 默认不进池，必须显式纳入', () => {
    const realIds = new Set(allJds.filter((j) => j.source === 'real').map((j) => j.id));
    expect(realIds.size).toBeGreaterThan(0);

    const def = buildCases(resumes, jds, { seed: 20261004 });
    expect(def.cases.some((c) => realIds.has(c.jd_id))).toBe(false);

    const withReal = buildCases(resumes, allJds, {
      seed: 20261004,
      version: 'ds-v1-real-seed20261004',
    });
    // 组数不变（每份简历 6 组），但池子里多了真实 JD，抽样就会抽到它们
    expect(withReal.cases).toHaveLength(def.cases.length);
    expect(withReal.cases.some((c) => realIds.has(c.jd_id))).toBe(true);
    // 版本号必须不同，否则"同一版本 = 同一内容"这个前提就不成立了
    expect(withReal.dataset.version).not.toBe(def.dataset.version);
  });

  it('简历必须已脱敏：不含手机号/邮箱', () => {
    const text = JSON.stringify(resumes);
    expect(/\d{11}/.test(text)).toBe(false);
    expect(/[\w.+-]+@[\w-]+\.[a-z]{2,}/i.test(text)).toBe(false);
  });
});
