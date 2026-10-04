import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

/**
 * 建库与连接。
 *
 * 用 Node 22.5+ 内置的 node:sqlite，不引 better-sqlite3——
 * 4 周版最怕的就是原生模块编译失败（Windows 上尤其）。
 * 代价：需要 Node >= 22.5，且 Node 22 下会打一条 ExperimentalWarning（无害）。
 */

export const SCHEMA_VERSION = 1;

export interface DbHandle {
  db: DatabaseSync;
  path: string;
  /** 当前 schema 版本（库里的，不是代码里的） */
  version: number;
}

function setPragmas(db: DatabaseSync): void {
  db.exec('PRAGMA foreign_keys = ON;');
  // WAL：读写不互相阻塞，但仍只允许一个写事务——所以引擎是单进程单写者
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec('PRAGMA synchronous = NORMAL;');
}

export function openDb(dbPath: string): DatabaseSync {
  const db = new DatabaseSync(dbPath);
  setPragmas(db);
  return db;
}

/** 幂等建表：schema.sql 里全是 CREATE TABLE IF NOT EXISTS，重复执行安全。 */
export function applySchema(db: DatabaseSync, schemaPath: string): void {
  const sql = readFileSync(schemaPath, 'utf8');
  db.exec(sql);
  db.prepare('INSERT OR REPLACE INTO schema_version (version, applied_at) VALUES (?, ?)').run(
    SCHEMA_VERSION,
    new Date().toISOString(),
  );
}

export function initDb(dbPath: string, schemaPath: string): DbHandle {
  const db = openDb(dbPath);
  applySchema(db, schemaPath);
  const row = db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as
    | { v: number | null }
    | undefined;
  return { db, path: dbPath, version: row?.v ?? 0 };
}

export function listTables(db: DatabaseSync): string[] {
  const rows = db
    .prepare(
      `SELECT name FROM sqlite_master
        WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
        ORDER BY name`,
    )
    .all() as Array<{ name: string }>;
  return rows.map((r) => r.name);
}

export function tableCounts(db: DatabaseSync): Array<{ table: string; rows: number }> {
  return listTables(db).map((table) => {
    const r = db.prepare(`SELECT COUNT(*) AS c FROM "${table}"`).get() as { c: number };
    return { table, rows: Number(r.c) };
  });
}
