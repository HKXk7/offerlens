/**
 * JD 库的读写与校验。
 *
 * 为什么要有这一层，而不是各处直接 `JSON.parse(readFileSync('data/jd/jds.json'))`：
 *
 *  1. **hash 必须基于规范化文本**。同一份 JD 从网页复制两次，一个用 \r\n、一个用 \n，
 *     末尾还差几个空格 —— 如果直接对原始串做 sha256，这两条会被判成"两份不同的 JD"，
 *     去重就失效了。所以先 normalize 再 hash。
 *  2. **写入顺序要固定**。JSON.stringify 会按对象自有属性的插入顺序输出，
 *     手工编辑和程序写入的字段顺序不一致，git diff 会变成整块重排、看不出真实改动。
 *  3. **校验要能给出可执行的信息**。只说"校验失败"没用，要说清哪一条 JD 的哪个字段
 *     为什么不行，尤其是 dataset_version 变了之后历史结论不可复现这件事。
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  JOB_CATEGORIES,
  type Jd,
  type JobCategory,
  type JdLevel,
} from '../schema/case.js';

export const JD_LEVELS: readonly JdLevel[] = ['intern', 'junior', 'senior'];

export const DEFAULT_JD_PATH = resolve(process.cwd(), 'data/jd/jds.json');

/**
 * 规范化 JD 原文。只做**不改变语义**的处理：
 *  - 统一换行为 \n（Windows 复制粘贴几乎必带 \r\n）
 *  - 去掉每行行尾空白（网页复制常带不间断空格/尾随空格）
 *  - 折叠连续空行（>2 个换行折成 2 个）
 *  - 去首尾空白
 *
 * 刻意**不**做的事：不删全角空格、不删水印字符（如 BOSS 直聘插的 `kanzhun`）。
 * 那些是真实数据的噪声，删掉就等于篡改原文 —— 清洗要在下游做，并且留痕。
 */
export function normalizeRaw(raw: string): string {
  return raw
    .replace(/\r\n?/g, '\n')
    .replace(/[\u00a0\u3000]/g, ' ')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** raw 的内容指纹（sha256 前 12 位）。12 位十六进制 ≈ 48 bit，去重场景足够且好读 */
export function hashContent(raw: string): string {
  return createHash('sha256').update(normalizeRaw(raw), 'utf8').digest('hex').slice(0, 12);
}

/**
 * 生成 JD id，形如 `jd-real-app-01`。
 *
 * 不用标题做 slug：中文标题转拼音既引入新依赖又不稳定，同一标题因为标点变化还会生成
 * 不同 id。改用「来源 + 类别 + 序号」，序号取该前缀下当前最大值 +1 —— 幂等、可读、
 * 且从 id 就能看出这条 JD 是合成的还是真实的。
 */
export function nextJdId(existing: readonly Jd[], category: JobCategory, source: Jd['source']): string {
  const prefix = `jd-${source === 'real' ? 'real-' : ''}${category}-`;
  let max = 0;
  for (const jd of existing) {
    if (!jd.id.startsWith(prefix)) continue;
    const n = Number.parseInt(jd.id.slice(prefix.length), 10);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return `${prefix}${String(max + 1).padStart(2, '0')}`;
}

/** 校验单条 JD。返回空数组表示通过 */
export function validateJd(jd: Jd): string[] {
  const errors: string[] = [];
  if (!jd.id || !/^jd-[a-z-]+-\d{2,}$/.test(jd.id)) {
    errors.push(`id 格式应为 jd-<category>-NN 或 jd-real-<category>-NN，实际为「${jd.id}」`);
  }
  if (!jd.title || jd.title.trim().length === 0) errors.push('title 不能为空');
  if (!JOB_CATEGORIES.includes(jd.category)) {
    errors.push(`category 必须是 ${JOB_CATEGORIES.join('/')} 之一，实际为「${jd.category}」`);
  }
  if (!JD_LEVELS.includes(jd.level)) {
    errors.push(`level 必须是 ${JD_LEVELS.join('/')} 之一，实际为「${jd.level}」`);
  }
  if (normalizeRaw(jd.raw).length < 40) {
    errors.push('raw 短于 40 字：真实 JD 不可能这么短，多半是只粘了标题');
  }
  if (jd.source === 'real') {
    // 这两条是 source=real 的成立条件。缺了它们，"真实"就只是一句自我声明。
    if (!jd.provenance) errors.push('source=real 时必须标注 provenance（manual-paste / search-curated）');
    if (!jd.collected_at) errors.push('source=real 时必须标注 collected_at（招聘 JD 会过期）');
    if (!/^\d{4}-\d{2}-\d{2}T/.test(jd.collected_at ?? '')) {
      errors.push(`collected_at 应为 ISO 8601（如 2026-11-23T03:00:00Z），实际为「${jd.collected_at}」`);
    }
  }
  if (jd.source === 'synthetic' && jd.provenance) {
    errors.push('source=synthetic 不应有 provenance：合成数据没有"获取方式"可言');
  }
  // 硬门槛至少要有格式上的区分度，否则 gate 指标恒为 0，看起来"模型很差"其实是标注为空
  if (jd.hard_req.some((h) => h.trim().length === 0)) {
    errors.push('hard_req 里有空字符串');
  }
  return errors;
}

/** 字段顺序固定，避免手工编辑与程序写入产生无意义的大段 diff */
function orderJd(jd: Jd): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: jd.id,
    title: jd.title,
    company_type: jd.company_type,
    category: jd.category,
    level: jd.level,
    source: jd.source,
  };
  if (jd.provenance !== undefined) out.provenance = jd.provenance;
  if (jd.collected_at !== undefined) out.collected_at = jd.collected_at;
  if (jd.source_url !== undefined) out.source_url = jd.source_url;
  if (jd.content_hash !== undefined) out.content_hash = jd.content_hash;
  out.raw = jd.raw;
  out.hard_req = jd.hard_req;
  out.soft_req = jd.soft_req;
  return out;
}

export function loadJds(path: string = DEFAULT_JD_PATH): Jd[] {
  return JSON.parse(readFileSync(path, 'utf8')) as Jd[];
}

export function saveJds(jds: readonly Jd[], path: string = DEFAULT_JD_PATH): void {
  const body = jds.map(orderJd);
  writeFileSync(path, `${JSON.stringify(body, null, 2)}\n`, 'utf8');
}

export type UpsertAction = 'inserted' | 'replaced' | 'duplicate';

export interface UpsertResult {
  jds: Jd[];
  action: UpsertAction;
  /** action=duplicate 时，指向已存在的那条 */
  duplicateOf?: string;
}

export class JdConflictError extends Error {}

/**
 * 插入或替换一条 JD。
 *
 * 去重按 content_hash 而不是 id：同一个岗位换个 id 再导入一次是常见误操作
 * （比如手滑跑了两次 jd:add），只有内容指纹能拦住它。
 * 同 id 但内容不同 = 想让这条 JD 更新，必须显式 force。
 */
export function upsertJd(
  existing: readonly Jd[],
  jd: Jd,
  opts: { force?: boolean } = {},
): UpsertResult {
  const byHash = existing.find((x) => x.content_hash === jd.content_hash);
  if (byHash && byHash.id !== jd.id) {
    return { jds: [...existing], action: 'duplicate', duplicateOf: byHash.id };
  }

  const idx = existing.findIndex((x) => x.id === jd.id);
  if (idx === -1) {
    return { jds: [...existing, jd], action: 'inserted' };
  }
  if (!opts.force) {
    throw new JdConflictError(
      `id「${jd.id}」已存在且内容不同。确认要覆盖请加 --force；` +
        '如果是同一岗位内容更新，建议保留旧条目并新增一条（采集时间不同、结论时效也不同）',
    );
  }
  const next = [...existing];
  next[idx] = jd;
  return { jds: next, action: 'replaced' };
}
