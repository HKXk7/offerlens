/**
 * 把「数据集 → 简历 → JD → 评测 case」这批**外键父行**写进 SQLite。
 *
 * 为什么要单独抽出来：`result` 表对 `eval_case (id)` 有外键约束，
 * 而 `eval_case` 只有在这个函数跑过之后才存在。之前这段逻辑写在 `build-cases.ts`
 * 里、还被 `--db` 开关包着 —— 于是 `npm run cases:build`（README 里的标准命令，
 * 不带 `--db`）根本不会写库，紧接着 `npm run demo` 就往一个空的 `eval_case` 上插
 * `result`，直接 `FOREIGN KEY constraint failed` 崩掉。
 *
 * 这个 bug 在开发机上一直看不见：本地库里早就有旧数据，外键能对上。
 * 它只在**全新的库**上出现 —— 也就是每一个第一次 clone 这个仓库的人。
 * 最终是 CI 的「零成本管线」那个 job 把它抓出来的。
 *
 * 现在两边共用同一份实现，顺序固定为 dataset → resume → jd → eval_case，
 * 谁调用都不会漏。
 */

import type { DatabaseSync } from 'node:sqlite';
import type { Case, Dataset, Jd, Resume } from '../schema/case.js';

export interface DatasetRows {
  dataset: Dataset;
  resumes: readonly Resume[];
  jds: readonly Jd[];
  cases: readonly Case[];
}

/** 幂等：全部用 INSERT OR REPLACE，重复执行不会重复插入 */
export function seedDatasetRows(db: DatabaseSync, rows: DatasetRows): void {
  const { dataset, resumes, jds, cases } = rows;

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
      r.id,
      r.anon_id,
      r.headline,
      r.experience_level,
      r.major_related ? 1 : 0,
      JSON.stringify(r.segments),
      JSON.stringify(r.skills),
      JSON.stringify({ internships: r.internships, projects: r.projects }),
    );
  }

  const insJd = db.prepare(
    `INSERT OR REPLACE INTO jd
     (id, title, company_type, category, level, raw, hard_req_json, soft_req_json, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const j of jds) {
    insJd.run(
      j.id,
      j.title,
      j.company_type,
      j.category,
      j.level,
      j.raw,
      JSON.stringify(j.hard_req),
      JSON.stringify(j.soft_req),
      j.source,
    );
  }

  const insCase = db.prepare(
    `INSERT OR REPLACE INTO eval_case
     (id, dataset_id, dataset_version, resume_id, jd_id, category, experience_level, level,
      is_hard_negative, is_golden)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const c of cases) {
    insCase.run(
      c.id,
      dataset.id,
      c.dataset_version,
      c.resume_id,
      c.jd_id,
      c.tags.category,
      c.tags.experience_level,
      c.tags.level,
      c.is_hard_negative ? 1 : 0,
      c.is_golden ? 1 : 0,
    );
  }
}
