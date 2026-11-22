/**
 * 落库顺序的回归测试。
 *
 * 背景（真实事故）：`result.case_id` 对 `eval_case (id)` 有外键约束。
 * 而 `eval_case` 只有在写库时才会被填上。原来的 `npm run cases:build`
 * 不带 `--db` 就不写库，于是紧接着的 `npm run demo` 往空表上插 result，
 * 报 `FOREIGN KEY constraint failed`。
 *
 * 之所以开发机上一直没暴露：本地库里早就有历史数据，外键对得上。
 * **它只在全新的库上复现 —— 也就是每一个第一次 clone 的人。**
 *
 * 这组测试就是拿一个临时空库，把这个顺序钉死：
 *   · 不塞父行 → 写 result 必须失败（证明外键真的开着，测试不是空转）
 *   · 塞了父行 → 写 result 必须成功
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildCases } from '../scripts/build-cases.js';
import { applySchema, openDb } from '../src/db/init.js';
import { seedDatasetRows } from '../src/db/seed-dataset.js';
import type { Jd, Resume } from '../src/schema/case.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCHEMA = resolve(ROOT, 'schema/schema.sql');

const jds = JSON.parse(readFileSync(resolve(ROOT, 'data/jd/jds.json'), 'utf8')) as Jd[];
const resumes = JSON.parse(readFileSync(resolve(ROOT, 'data/resumes/resumes.json'), 'utf8')) as Resume[];

type Db = ReturnType<typeof openDb>;

let tmp: string;
let db: Db;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'offerlens-db-'));
  db = openDb(join(tmp, 'test.db'));
  applySchema(db, SCHEMA);
});

afterEach(() => {
  try {
    db.close();
  } catch {
    /* 已关闭则忽略 */
  }
  rmSync(tmp, { recursive: true, force: true });
});

/** 造一条最小的 eval_run（result 的直接父行） */
function insertRun(datasetId: string, version: string): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO eval_run
     (id, dataset_id, dataset_version, model, prompt_version, params_json, status,
      budget_limit_usd, spent_usd, seed, created_at, updated_at)
     VALUES ('run-test', ?, ?, 'test-model', 'p2-strict', '{}', 'done', 1, 0, 42, ?, ?)`,
  ).run(datasetId, version, now, now);
}

function insertResult(caseId: string): void {
  db.prepare(
    `INSERT INTO result
     (run_id, case_id, run_index, output_json, scores_json, latency_ms, input_tokens,
      output_tokens, cost_usd, error_type, retry_count, cached, created_at)
     VALUES ('run-test', ?, 0, '{}', '{}', 1, 0, 0, 0, NULL, 0, 0, ?)`,
  ).run(caseId, new Date().toISOString());
}

describe('外键顺序：父行必须先于 result 落库', () => {
  it('eval_case 为空时写 result 必须失败（证明外键真的开着）', () => {
    const { dataset, cases } = buildCases(resumes, jds, { seed: 20261004 });

    // 只塞 dataset / resume / jd，故意把 eval_case 留空，隔离变量
    seedDatasetRows(db, { dataset, resumes, jds, cases: [] });
    insertRun(dataset.id, dataset.version);

    expect(() => insertResult(cases[0].id)).toThrow(/FOREIGN KEY/i);
  });

  it('seedDatasetRows 之后，result 可以正常写入', () => {
    const { dataset, cases } = buildCases(resumes, jds, { seed: 20261004 });

    seedDatasetRows(db, { dataset, resumes, jds, cases });
    insertRun(dataset.id, dataset.version);

    expect(() => insertResult(cases[0].id)).not.toThrow();

    const n = db.prepare('SELECT COUNT(*) AS c FROM result').get() as { c: number };
    expect(n.c).toBe(1);
  });

  it('重复调用 seedDatasetRows 是幂等的（不撞主键、不翻倍）', () => {
    const { dataset, cases } = buildCases(resumes, jds, { seed: 20261004 });

    seedDatasetRows(db, { dataset, resumes, jds, cases });
    seedDatasetRows(db, { dataset, resumes, jds, cases });

    const count = (t: string) =>
      (db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get() as { c: number }).c;

    expect(count('dataset')).toBe(1);
    expect(count('resume')).toBe(resumes.length);
    expect(count('jd')).toBe(jds.length);
    expect(count('eval_case')).toBe(cases.length);
  });

  it('同一个 result 主键写两次只留一行（幂等主键生效）', () => {
    const { dataset, cases } = buildCases(resumes, jds, { seed: 20261004 });

    seedDatasetRows(db, { dataset, resumes, jds, cases });
    insertRun(dataset.id, dataset.version);
    insertResult(cases[0].id);

    // runner 用 INSERT OR IGNORE 跳过重复；这里直接验证主键约束本身存在
    expect(() => insertResult(cases[0].id)).toThrow(/UNIQUE|PRIMARY KEY/i);
  });
});
