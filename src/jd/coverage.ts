/**
 * JD 覆盖度统计。
 *
 * 一个评测平台最容易被忽略的问题不是"指标算错了"，而是**样本根本不够**：
 * `business/senior` 一格只有 0 条，却在报告里和 `app/junior` 的 12 条并列展示，
 * 读者会以为"各档位都有结论"，实际上那一档什么都没测过。
 *
 * 所以覆盖度必须是**可见的一等公民**，而不是等别人来挑。
 *
 * 另一条硬规则：**synthetic 与 real 分开统计、绝不合并**。
 * 合成 JD 的 hard_req 是手写的、措辞规整，gate_hit 天然偏高；
 * 把两者混在一个均值里，等于用一个好看的数掩盖"真实场景下更差"这件事。
 */

import {
  JOB_CATEGORIES,
  JOB_CATEGORY_LABEL,
  type Jd,
  type JobCategory,
  type JdLevel,
} from '../schema/case.js';
import { JD_LEVELS } from './store.js';

export const JD_LEVEL_LABEL: Record<JdLevel, string> = {
  intern: '实习',
  junior: '1-3 年',
  senior: '3 年以上',
};

export interface SourceStats {
  count: number;
  /** 原文平均字数 —— 真实 JD 通常远长于合成 JD，这是"干净程度"最直观的代理指标 */
  avgRawLength: number;
  avgHardReq: number;
  avgSoftReq: number;
  /** hard_req 标注为空的条数：这些 JD 进评测集会让 gate 指标恒为 0 */
  hardReqEmpty: number;
  /** 缺 content_hash 的条数（历史数据迁移前后的区别） */
  missingHash: number;
  /** source=real 但缺 provenance/collected_at 的条数：无法回溯来源 */
  missingProvenance: number;
}

export interface JdCoverage {
  total: number;
  matrix: Record<JobCategory, Record<JdLevel, number>>;
  gaps: Array<{ category: JobCategory; level: JdLevel }>;
  /** 同一 content_hash 对应多个 id —— 同一岗位被导入两次 */
  duplicates: Array<{ hash: string; ids: string[] }>;
  bySource: Record<'synthetic' | 'real', SourceStats>;
}

function emptyMatrix(): Record<JobCategory, Record<JdLevel, number>> {
  const out = {} as Record<JobCategory, Record<JdLevel, number>>;
  for (const c of JOB_CATEGORIES) {
    out[c] = { intern: 0, junior: 0, senior: 0 };
  }
  return out;
}

function statsOf(jds: readonly Jd[]): SourceStats {
  const n = jds.length;
  const avg = (pick: (jd: Jd) => number): number =>
    n === 0 ? 0 : Math.round((jds.reduce((a, jd) => a + pick(jd), 0) / n) * 10) / 10;
  return {
    count: n,
    avgRawLength: avg((jd) => jd.raw.length),
    avgHardReq: avg((jd) => jd.hard_req.length),
    avgSoftReq: avg((jd) => jd.soft_req.length),
    hardReqEmpty: jds.filter((jd) => jd.hard_req.length === 0).length,
    missingHash: jds.filter((jd) => !jd.content_hash).length,
    missingProvenance: jds.filter(
      (jd) => jd.source === 'real' && (!jd.provenance || !jd.collected_at),
    ).length,
  };
}

export function computeCoverage(jds: readonly Jd[]): JdCoverage {
  const matrix = emptyMatrix();
  for (const jd of jds) {
    matrix[jd.category][jd.level] += 1;
  }

  const gaps: JdCoverage['gaps'] = [];
  for (const c of JOB_CATEGORIES) {
    for (const l of JD_LEVELS) {
      if (matrix[c][l] === 0) gaps.push({ category: c, level: l });
    }
  }

  const byHash = new Map<string, string[]>();
  for (const jd of jds) {
    if (!jd.content_hash) continue;
    const ids = byHash.get(jd.content_hash) ?? [];
    ids.push(jd.id);
    byHash.set(jd.content_hash, ids);
  }
  const duplicates = [...byHash.entries()]
    .filter(([, ids]) => ids.length > 1)
    .map(([hash, ids]) => ({ hash, ids }));

  return {
    total: jds.length,
    matrix,
    gaps,
    duplicates,
    bySource: {
      synthetic: statsOf(jds.filter((jd) => jd.source === 'synthetic')),
      real: statsOf(jds.filter((jd) => jd.source === 'real')),
    },
  };
}

const pct = (n: number, total: number): string =>
  total === 0 ? '—' : `${((n / total) * 100).toFixed(0)}%`;

/**
 * 字符的终端显示宽度。
 *
 * `String.prototype.padEnd` 按**字符数**补齐，而中文在全角终端里占 2 列，
 * 于是 `'AI 应用前端'.padEnd(12)` 看着补了，打印出来仍然是歪的。
 * 表格错位对"专业感"的杀伤力比想象中大 —— 读者第一眼看到的是歪的，不是内容。
 */
function charWidth(cp: number): number {
  if (cp < 0x1100) return 1;
  return cp <= 0x115f ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f9ff) ||
    cp >= 0x20000
    ? 2
    : 1;
}

export function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) w += charWidth(ch.codePointAt(0) ?? 0);
  return w;
}

/** 按显示宽度右补空格（CJK 占 2 列） */
export function padDisplay(s: string, width: number): string {
  return s + ' '.repeat(Math.max(0, width - displayWidth(s)));
}

/** 渲染成终端可读的表格（纯函数，CLI 与测试共用） */
export function renderCoverage(c: JdCoverage): string {
  const L: string[] = [];
  L.push(`JD 库：共 ${c.total} 条（合成 ${c.bySource.synthetic.count} · 真实 ${c.bySource.real.count}）`);
  L.push('');

  L.push('覆盖矩阵（category × level）');
  L.push(`  ${padDisplay('类别', 26)}${JD_LEVELS.map((l) => padDisplay(JD_LEVEL_LABEL[l], 10)).join('')}`);
  for (const cat of JOB_CATEGORIES) {
    const cells = JD_LEVELS.map((l) => {
      const n = c.matrix[cat][l];
      return padDisplay(n === 0 ? '缺' : String(n), 10);
    });
    const name = `${JOB_CATEGORY_LABEL[cat]}（${cat}）`;
    L.push(`  ${padDisplay(name, 26)}${cells.join('')}`);
  }
  L.push('');

  if (c.gaps.length > 0) {
    L.push(`缺口 ${c.gaps.length} 格：${c.gaps.map((g) => `${g.category}/${g.level}`).join('、')}`);
    L.push('  （缺格的档位不能出结论，只能标"未覆盖"，不要和别的档位并列展示）');
  } else {
    L.push('覆盖矩阵无缺口');
  }
  L.push('');

  L.push('按来源分组（刻意不合并统计）');
  for (const key of ['synthetic', 'real'] as const) {
    const s = c.bySource[key];
    const label = key === 'synthetic' ? '合成' : '真实';
    if (s.count === 0) {
      L.push(`  ${label}：0 条`);
      continue;
    }
    L.push(
      `  ${label}：${s.count} 条 · 原文均长 ${s.avgRawLength} 字 · ` +
        `hard_req 均 ${s.avgHardReq} 条 · soft_req 均 ${s.avgSoftReq} 条`,
    );
    const warns: string[] = [];
    if (s.hardReqEmpty > 0) warns.push(`${s.hardReqEmpty} 条 hard_req 为空（gate 指标会恒为 0）`);
    if (s.missingHash > 0) warns.push(`${s.missingHash} 条缺 content_hash（无法去重）`);
    if (s.missingProvenance > 0) warns.push(`${s.missingProvenance} 条缺来源标注（无法回溯）`);
    if (warns.length > 0) L.push(`      ⚠ ${warns.join('；')}`);
  }
  L.push('');

  if (c.bySource.synthetic.count > 0 && c.bySource.real.count > 0) {
    const syn = c.bySource.synthetic;
    const real = c.bySource.real;
    const lenRatio = syn.avgRawLength === 0 ? 0 : real.avgRawLength / syn.avgRawLength;
    L.push(
      `真实 / 合成 原文长度比：${lenRatio.toFixed(2)}×` +
        (lenRatio < 0.8
          ? ' —— 真实样本明显更短，先检查是不是只粘了职责没粘要求'
          : lenRatio > 1.3
            ? ' —— 真实 JD 明显更长（套话与福利条款多），hard_req 抽取会更难'
            : ''),
    );
    L.push(
      `hard_req 条数比：${(real.avgHardReq / Math.max(syn.avgHardReq, 0.1)).toFixed(2)}×` +
        `　（合成 ${syn.avgHardReq} / 真实 ${real.avgHardReq}）`,
    );
  } else if (c.bySource.real.count === 0) {
    L.push('真实样本为 0：当前所有结论的适用范围仅限"合成 JD"，不能外推到真实投递场景。');
    L.push('  补真实 JD：npm run jd:add -- --file 岗位.txt --title "标题" --category app --level senior \\');
    L.push('                        --company-type 大厂 --source real --provenance manual-paste --url https://...');
  }

  if (c.duplicates.length > 0) {
    L.push('');
    L.push(`重复内容 ${c.duplicates.length} 组：`);
    for (const d of c.duplicates) L.push(`  ${d.hash} → ${d.ids.join(', ')}`);
  }

  return L.join('\n');
}

export { pct as formatPct };
