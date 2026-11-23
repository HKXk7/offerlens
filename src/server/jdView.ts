/**
 * `/api/jds` 的视图层。
 *
 * 抽成纯函数而不是写在 server.ts 里，有两个原因：
 *  1. 能单测 —— 「矩阵有没有把缺口标出来」「真实/合成有没有被合并」这两件事
 *     一旦写错，页面会理直气壮地展示一个错的结论。
 *  2. 视图层只做裁剪（不把 raw 全文塞给浏览器），业务判断全在 `jd/coverage.ts`。
 *
 * 一条硬规则：**不在这一层做任何合并**。合成与真实的均值相加，
 * 等于用一个好看的数掩盖「真实场景更差」，这正是这个页面要防的事。
 */

import {
  JOB_CATEGORIES,
  JOB_CATEGORY_LABEL,
  type Jd,
  type JdLevel,
  type JobCategory,
} from '../schema/case.js';
import { computeCoverage, JD_LEVEL_LABEL, type JdCoverage } from '../jd/coverage.js';
import { JD_LEVELS } from '../jd/store.js';

/** 列表里只给摘要，原文的全文不给浏览器（长且含有噪声水印） */
export interface JdListItem {
  id: string;
  title: string;
  company_type: string;
  category: JobCategory;
  level: JdLevel;
  source: 'synthetic' | 'real';
  provenance: string | null;
  collected_at: string | null;
  source_url: string | null;
  raw_length: number;
  hard_req: string[];
  soft_req: string[];
  /** 前 140 字，用于让人确认「这条确实是那个岗位」 */
  excerpt: string;
  content_hash: string | null;
}

export interface JdView {
  total: number;
  coverage: JdCoverage;
  items: JdListItem[];
  labels: {
    categories: Record<JobCategory, string>;
    levels: Record<JdLevel, string>;
    /** 前端按这个顺序渲染行列，顺序由后端定，避免两处各写一份 */
    categoryOrder: readonly JobCategory[];
    levelOrder: readonly JdLevel[];
  };
}

const EXCERPT_CHARS = 140;

function toItem(jd: Jd): JdListItem {
  const flat = jd.raw.replace(/\s+/g, ' ').trim();
  return {
    id: jd.id,
    title: jd.title,
    company_type: jd.company_type,
    category: jd.category,
    level: jd.level,
    source: jd.source,
    provenance: jd.provenance ?? null,
    collected_at: jd.collected_at ?? null,
    source_url: jd.source_url ?? null,
    raw_length: jd.raw.length,
    hard_req: jd.hard_req,
    soft_req: jd.soft_req,
    excerpt: flat.length > EXCERPT_CHARS ? `${flat.slice(0, EXCERPT_CHARS)}…` : flat,
    content_hash: jd.content_hash ?? null,
  };
}

/**
 * 排序的意图：**真实数据排前面**。
 *
 * 页面第一屏应该看到「真实在招岗位」，而不是 12 条手写样本 ——
 * 后者看起来更整齐，但恰好是最不能作为结论依据的那部分。
 */
function sortItems(items: JdListItem[]): JdListItem[] {
  const catIdx = (c: JobCategory): number => JOB_CATEGORIES.indexOf(c);
  const lvlIdx = (l: JdLevel): number => JD_LEVELS.indexOf(l);
  return [...items].sort((a, b) => {
    if (a.source !== b.source) return a.source === 'real' ? -1 : 1;
    if (catIdx(a.category) !== catIdx(b.category)) return catIdx(a.category) - catIdx(b.category);
    if (lvlIdx(a.level) !== lvlIdx(b.level)) return lvlIdx(a.level) - lvlIdx(b.level);
    return a.id.localeCompare(b.id);
  });
}

export function buildJdView(jds: readonly Jd[]): JdView {
  return {
    total: jds.length,
    coverage: computeCoverage(jds),
    items: sortItems(jds.map(toItem)),
    labels: {
      categories: JOB_CATEGORY_LABEL,
      levels: JD_LEVEL_LABEL,
      categoryOrder: JOB_CATEGORIES,
      levelOrder: JD_LEVELS,
    },
  };
}
