/**
 * 评测集组装：从 12 个 JD × 4 份合成简历里，用固定种子抽 24 组 case。
 *
 * 为什么不是随机抽 24 组：
 *   随机抽很可能抽出"某个简历一组都没进"或者"某类岗位全军覆没"，
 *   那样切片下钻的结论就没法看。所以要分层：
 *     每组简历都出现（4 × 6 = 24）
 *     每组简历都覆盖全部 4 个岗位类别
 *     4 组 golden（每组简历里最匹配的那组，用于长期监控）
 *     4 组 hard negative（明显不匹配的组，看模型会不会硬夸）
 *
 * 用法：
 *   npx tsx scripts/build-cases.ts                # 只产出 cases.jsonl
 *   npx tsx scripts/build-cases.ts --seed 20261004
 *   npx tsx scripts/build-cases.ts --db           # 同时写入 SQLite
 */
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadJsonCollection, writeJson, writeJsonl } from '../src/lib/jsonl.js';
import { mulberry32, type Rng } from '../src/lib/prng.js';
import {
  JOB_CATEGORIES,
  JOB_CATEGORY_LABEL,
  EXPERIENCE_LABEL,
  type Case,
  type Dataset,
  type Jd,
  type JobCategory,
  type Resume,
} from '../src/schema/case.js';
import { initDb } from '../src/db/init.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const CASES_PER_RESUME = 6;
const GOLDEN_PER_RESUME = 1;
const HARD_NEGATIVE_TOTAL = 4;

/* ------------------------------------------------------------------ */
/* 硬门槛命中判定                                                      */
/* ------------------------------------------------------------------ */

/** 门槛词的别名与等价写法。简历里不会原样出现 JD 的措辞，所以必须归一。 */
const GATE_ALIAS: Record<string, string[]> = {
  '本科及以上': ['本科'],
  '实习 3 个月起': ['实习'],
};

/** 这些门槛词不能用文本匹配判定，要么看结构化字段，要么永远不命中。 */
const GATE_NO_TEXT_MATCH = new Set(['计算机相关专业', '5 年以上前端经验']);

function normalizeText(s: string): string {
  return s.toLowerCase().replace(/\s+/g, '');
}

function resumeFullText(r: Resume): string {
  return normalizeText(
    [r.headline, ...r.skills, ...r.internships, ...r.projects, ...r.segments.map((s) => s.text)].join('\n'),
  );
}

function gateHit(gate: string, resume: Resume, resumeText: string): boolean {
  // 专业对口看结构化字段，不看文本
  if (gate === '计算机相关专业') return resume.major_related;
  // 年资类门槛对学生简历一律不命中（这正是"硬门槛"的意义）
  if (gate === '5 年以上前端经验') return false;
  const synonyms = GATE_ALIAS[gate];
  const terms = synonyms && synonyms.length > 0 ? synonyms : [gate];
  return terms.some((syn) => resumeText.includes(normalizeText(syn)));
}

/** 命中多少个硬门槛 —— 用来判定"最匹配的那组"（golden）与"最不匹配的组"（hard negative）。 */
export function gateOverlap(resume: Resume, jd: Jd): number {
  const text = resumeFullText(resume);
  return jd.hard_req.filter((g) => gateHit(g, resume, text)).length;
}

/** 规则式的"明显不匹配"判定，用来解释为什么这组是 hard negative。 */
export function hardNegativeReason(resume: Resume, jd: Jd): string | null {
  if (jd.level === 'senior' && (resume.experience_level === 'thin' || resume.experience_level === 'incomplete')) {
    return `高级岗要求 5 年经验，而简历是「${EXPERIENCE_LABEL[resume.experience_level]}」——看模型会不会不提问门槛就硬夸`;
  }
  if (!resume.major_related && jd.hard_req.includes('计算机相关专业')) {
    return '非计算机相关专业 × 硬门槛明确要求「计算机相关专业」';
  }
  if (!resume.major_related && jd.category === 'platform') {
    return '转行简历 × 平台型岗位（要求 React/TS，简历只有 Vue）';
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* 分层抽样                                                            */
/* ------------------------------------------------------------------ */

function rotate<T>(arr: readonly T[], offset: number): T[] {
  const n = arr.length;
  const o = ((offset % n) + n) % n;
  return [...arr.slice(o), ...arr.slice(0, o)];
}

/** 为一份简历挑 6 个 JD：4 个类别各一个 + 再补 2 个，保证类别覆盖。 */
function pickJdsForResume(resume: Resume, jds: readonly Jd[], rng: Rng): Jd[] {
  const byCategory = new Map<JobCategory, Jd[]>();
  for (const c of JOB_CATEGORIES) {
    byCategory.set(c, rng.shuffle(jds.filter((j) => j.category === c)));
  }
  const order = rotate(JOB_CATEGORIES, rng.int(JOB_CATEGORIES.length));
  const chosen: Jd[] = [];
  const usedJd = new Set<string>();

  const takeFrom = (c: JobCategory) => {
    const pool = byCategory.get(c) ?? [];
    while (pool.length > 0) {
      const jd = pool.shift() as Jd;
      if (!usedJd.has(jd.id)) {
        usedJd.add(jd.id);
        chosen.push(jd);
        return;
      }
    }
  };

  for (const c of order) takeFrom(c);
  // 补齐到 6 个：从另一段旋转顺序里再取，保证不重复类别优先
  const extraOrder = rotate(JOB_CATEGORIES, rng.int(JOB_CATEGORIES.length));
  let cursor = 0;
  while (chosen.length < CASES_PER_RESUME && cursor < extraOrder.length * 3) {
    takeFrom(extraOrder[cursor % extraOrder.length]);
    cursor++;
  }
  return chosen;
}

export interface BuildResult {
  dataset: Dataset;
  cases: Case[];
  hardNegativeReasons: Record<string, string>;
}

export function buildCases(
  resumes: readonly Resume[],
  jds: readonly Jd[],
  opts: { version?: string; seed?: number } = {},
): BuildResult {
  const seed = opts.seed ?? 20261004;
  const version = opts.version ?? `ds-v1-seed${seed}`;
  const rng = mulberry32(seed);

  // 每种类别至少要有 CASES_PER_RESUME / 类别数 个 JD 才能覆盖
  for (const c of JOB_CATEGORIES) {
    const n = jds.filter((j) => j.category === c).length;
    if (n < 1) throw new Error(`类别 ${c} 没有任何 JD，无法覆盖`);
  }

  const raw: Array<{ resume: Resume; jd: Jd }> = [];
  for (const resume of rng.shuffle(resumes)) {
    for (const jd of pickJdsForResume(resume, jds, rng)) raw.push({ resume, jd });
  }

  // --- hard negative：优先用规则命中，不够再用"命中门槛最少"的补齐 ---
  const scored = raw.map((p, i) => ({ ...p, index: i, score: gateOverlap(p.resume, p.jd) }));
  const byRule = scored.filter((p) => hardNegativeReason(p.resume, p.jd) !== null);
  const hardNegatives = new Set<number>();
  for (const p of byRule) {
    if (hardNegatives.size >= HARD_NEGATIVE_TOTAL) break;
    hardNegatives.add(p.index);
  }
  if (hardNegatives.size < HARD_NEGATIVE_TOTAL) {
    const rest = scored
      .filter((p) => !hardNegatives.has(p.index))
      .sort((a, b) => a.score - b.score || a.index - b.index);
    for (const p of rest) {
      if (hardNegatives.size >= HARD_NEGATIVE_TOTAL) break;
      hardNegatives.add(p.index);
    }
  }

  // --- golden：每组简历里命中门槛最多的那组（排除已判为 hard negative 的） ---
  const golden = new Set<number>();
  for (const resume of resumes) {
    const candidates = scored
      .filter((p) => p.resume.id === resume.id && !hardNegatives.has(p.index))
      .sort((a, b) => b.score - a.score || a.index - b.index);
    const best = candidates[0];
    if (best && golden.size < resumes.length * GOLDEN_PER_RESUME) golden.add(best.index);
  }

  const hardNegativeReasons: Record<string, string> = {};
  const cases: Case[] = scored.map((p) => {
    const id = `case-${p.resume.anon_id}-${p.jd.id}`;
    const isHard = hardNegatives.has(p.index);
    const reason = isHard
      ? hardNegativeReason(p.resume, p.jd) ?? `硬门槛命中数最低（${p.score} / ${p.jd.hard_req.length}）`
      : '';
    if (reason) hardNegativeReasons[id] = reason;
    return {
      id,
      dataset_version: version,
      resume_id: p.resume.id,
      jd_id: p.jd.id,
      tags: {
        category: p.jd.category,
        experience_level: p.resume.experience_level,
        level: p.jd.level,
      },
      is_hard_negative: isHard,
      is_golden: golden.has(p.index),
    };
  });

  cases.sort((a, b) => a.id.localeCompare(b.id));

  return {
    dataset: { id: 'offerlens-resume-jd', version, seed, created_at: new Date().toISOString() },
    cases,
    hardNegativeReasons,
  };
}

/* ------------------------------------------------------------------ */
/* CLI                                                                 */
/* ------------------------------------------------------------------ */

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function main(): void {
  const seed = Number(argValue('seed') ?? 20261004);
  const jds = loadJsonCollection<Jd>(resolve(ROOT, 'data/jd'));
  const resumes = loadJsonCollection<Resume>(resolve(ROOT, 'data/resumes'));

  const { dataset, cases, hardNegativeReasons } = buildCases(resumes, jds, { seed });

  writeJsonl(resolve(ROOT, 'data/cases/cases.jsonl'), cases);
  writeJson(resolve(ROOT, 'data/cases/dataset.json'), dataset);
  writeJson(resolve(ROOT, 'data/cases/hard-negatives.json'), hardNegativeReasons);

  console.log(`✅ 评测集已生成`);
  console.log(`   版本    : ${dataset.version}`);
  console.log(`   种子    : ${dataset.seed}（换种子会得到不同的一批 case，但同一版本内必须可复现）`);
  console.log(`   规模    : ${jds.length} JD × ${resumes.length} 简历 → ${cases.length} 组 case`);
  console.log(`   golden  : ${cases.filter((c) => c.is_golden).length} 组`);
  console.log(`   难例    : ${cases.filter((c) => c.is_hard_negative).length} 组`);

  console.log('\n按岗位类别分布：');
  for (const c of JOB_CATEGORIES) {
    const n = cases.filter((x) => x.tags.category === c).length;
    console.log(`   ${JOB_CATEGORY_LABEL[c].padEnd(12)} ${n}`);
  }
  console.log('\n按简历分布：');
  for (const r of resumes) {
    const n = cases.filter((x) => x.resume_id === r.id).length;
    console.log(`   ${r.anon_id} ${EXPERIENCE_LABEL[r.experience_level].padEnd(22)} ${n}`);
  }

  if (process.argv.includes('--db')) {
    const handle = initDb(resolve(ROOT, 'data/offerlens.db'), resolve(ROOT, 'schema/schema.sql'));
    const { db } = handle;
    db.prepare(
      'INSERT OR REPLACE INTO dataset (id, version, seed, created_at) VALUES (?, ?, ?, ?)',
    ).run(dataset.id, dataset.version, dataset.seed, dataset.created_at);

    const insResume = db.prepare(
      `INSERT OR REPLACE INTO resume
       (id, anon_id, headline, experience_level, major_related, segments_json, skills_json, profile_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const r of resumes) {
      insResume.run(
        r.id, r.anon_id, r.headline, r.experience_level, r.major_related ? 1 : 0,
        JSON.stringify(r.segments), JSON.stringify(r.skills),
        JSON.stringify({ internships: r.internships, projects: r.projects }),
      );
    }

    const insJd = db.prepare(
      `INSERT OR REPLACE INTO jd
       (id, title, company_type, category, level, raw, hard_req_json, soft_req_json, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const j of jds) {
      insJd.run(j.id, j.title, j.company_type, j.category, j.level, j.raw,
        JSON.stringify(j.hard_req), JSON.stringify(j.soft_req), j.source);
    }

    const insCase = db.prepare(
      `INSERT OR REPLACE INTO eval_case
       (id, dataset_id, dataset_version, resume_id, jd_id, category, experience_level, level,
        is_hard_negative, is_golden)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const c of cases) {
      insCase.run(c.id, dataset.id, c.dataset_version, c.resume_id, c.jd_id, c.tags.category,
        c.tags.experience_level, c.tags.level, c.is_hard_negative ? 1 : 0, c.is_golden ? 1 : 0);
    }
    const total = db.prepare('SELECT COUNT(*) AS c FROM eval_case').get() as { c: number };
    console.log(`\n✅ 已写入 SQLite：eval_case 现有 ${total.c} 行`);
    db.close();
  }

  console.log('\n难例说明：');
  for (const [id, reason] of Object.entries(hardNegativeReasons)) {
    console.log(`   ${id}`);
    console.log(`      ${reason}`);
  }
}

// 只有被直接执行时才跑 CLI，被测试 import 时保持静默
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
