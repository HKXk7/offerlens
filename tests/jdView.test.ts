import { describe, expect, it } from 'vitest';
import { buildJdView } from '../src/server/jdView.js';
import type { Jd } from '../src/schema/case.js';

/**
 * 这一层的测试重点不是"字段有没有透传"，而是**它会不会自作聪明地合并统计**。
 * 合成与真实的均值一旦被平均，页面就会用一个好看的数掩盖"真实场景更差"，
 * 而且这种错误在读代码时完全看不出来 —— 只能靠断言守住。
 */

function jd(over: Partial<Jd>): Jd {
  return {
    id: 'jd-app-01',
    title: '前端工程师',
    company_type: '大厂',
    category: 'app',
    level: 'senior',
    raw: '岗位职责：负责控制台开发。任职要求：本科及以上。',
    hard_req: ['本科及以上'],
    soft_req: [],
    source: 'synthetic',
    ...over,
  };
}

describe('buildJdView', () => {
  it('合成与真实分开统计，不合并均值', () => {
    const view = buildJdView([
      jd({ id: 'jd-app-01', raw: '短'.repeat(10) }),
      jd({ id: 'jd-real-app-01', source: 'real', raw: '长'.repeat(100) }),
    ]);
    expect(view.coverage.bySource.synthetic.count).toBe(1);
    expect(view.coverage.bySource.real.count).toBe(1);
    expect(view.coverage.bySource.synthetic.avgRawLength).toBe(10);
    expect(view.coverage.bySource.real.avgRawLength).toBe(100);
    // 合并的错误形态：total 当分母算一个 55 的均值。这里必须不出现
    expect(view.coverage.bySource.real.avgRawLength).not.toBe(55);
  });

  it('空档位计入 gaps，且矩阵里确实是 0', () => {
    const view = buildJdView([jd({ id: 'jd-app-01' })]);
    expect(view.coverage.gaps.length).toBeGreaterThan(0);
    expect(view.coverage.gaps.some((g) => g.category === 'business' && g.level === 'senior')).toBe(true);
    expect(view.coverage.matrix.business.senior).toBe(0);
  });

  it('真实数据排在合成前面：第一屏就该看到真实样本', () => {
    const view = buildJdView([
      jd({ id: 'jd-app-01' }),
      jd({ id: 'jd-real-platform-09', source: 'real', category: 'platform' }),
    ]);
    expect(view.items[0].source).toBe('real');
  });

  it('同一来源内按 类别 → 档位 → id 排序，保证两次渲染一致', () => {
    const view = buildJdView([
      jd({ id: 'jd-business-02', category: 'business', level: 'senior' }),
      jd({ id: 'jd-app-02', level: 'intern' }),
      jd({ id: 'jd-app-01', level: 'intern' }),
    ]);
    expect(view.items.map((i) => i.id)).toEqual(['jd-app-01', 'jd-app-02', 'jd-business-02']);
  });

  it('长原文被截成摘要，不把全文塞给浏览器', () => {
    const view = buildJdView([jd({ raw: '甲'.repeat(500) })]);
    expect(view.items[0].excerpt.length).toBeLessThanOrEqual(141); // 140 + 省略号
    expect(view.items[0].excerpt.endsWith('…')).toBe(true);
    // 长度字段仍然是真实长度 —— 摘要短了不代表原文短
    expect(view.items[0].raw_length).toBe(500);
  });

  it('短原文不截断、不加省略号', () => {
    const view = buildJdView([jd({ raw: '很短的一段' })]);
    expect(view.items[0].excerpt).toBe('很短的一段');
  });

  it('来源字段缺失时给 null，而不是 undefined（JSON 里 undefined 会直接消失）', () => {
    const view = buildJdView([jd({ source: 'real' })]);
    const item = view.items[0];
    expect(item.provenance).toBeNull();
    expect(item.collected_at).toBeNull();
    expect(item.source_url).toBeNull();
    expect(item.content_hash).toBeNull();
    // 序列化后字段必须还在，前端才能显示"缺来源链接"
    expect(Object.keys(JSON.parse(JSON.stringify(item)))).toContain('source_url');
  });

  it('缺来源标注的真实 JD 会被计入 missingProvenance', () => {
    const view = buildJdView([jd({ source: 'real' })]);
    expect(view.coverage.bySource.real.missingProvenance).toBe(1);
  });

  it('排序顺序由后端给出，前端不各写一份', () => {
    const view = buildJdView([jd({})]);
    expect(view.labels.categoryOrder).toEqual(['app', 'platform', 'data', 'business']);
    expect(view.labels.levelOrder).toEqual(['intern', 'junior', 'senior']);
  });
});
