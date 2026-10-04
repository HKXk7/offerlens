/**
 * 建库脚本：node --run db:init   （或 npx tsx scripts/init-db.ts）
 *
 * 幂等：重复执行不会丢数据，schema.sql 里全是 IF NOT EXISTS。
 */
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initDb, listTables, tableCounts } from '../src/db/init.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dbPath = resolve(ROOT, process.argv[2] ?? 'data/offerlens.db');
const schemaPath = resolve(ROOT, 'schema/schema.sql');

mkdirSync(dirname(dbPath), { recursive: true });

const handle = initDb(dbPath, schemaPath);

console.log(`✅ 建库完成
   文件      : ${dbPath}
   schema 版本: v${handle.version}
   表数量    : ${listTables(handle.db).length}`);

const counts = tableCounts(handle.db);
console.log('\n当前行数：');
for (const { table, rows } of counts) {
  console.log(`   ${table.padEnd(18)} ${rows}`);
}

handle.db.close();
