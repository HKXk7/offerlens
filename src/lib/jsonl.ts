import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * JSONL 读写。
 *
 * 为什么 trace 用 JSONL 而不是 SQLite 存全文：
 * 一条 agent trace 的输入输出很容易上兆，塞进 SQLite 会让库变大、也让"一键删除我的数据"变慢。
 * 约定：全文落 JSONL 文件，SQLite 里只存摘要（digest）和索引字段。
 */

export function readJsonl<T>(path: string): T[] {
  const text = readFileSync(path, 'utf8');
  const out: T[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim().length === 0) continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch (err) {
      throw new Error(`${path}:${i + 1} JSON 解析失败：${(err as Error).message}`);
    }
  }
  return out;
}

export function writeJsonl(path: string, rows: readonly unknown[]): void {
  mkdirSync(dirname(path), { recursive: true });
  const body = rows.map((r) => JSON.stringify(r)).join('\n');
  writeFileSync(path, rows.length > 0 ? `${body}\n` : '', 'utf8');
}

export function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

export function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

/**
 * 读一组 JSON：既接受单个数组文件（如 jds.json），
 * 也接受一个目录下多个 .json 文件。方便你后面把 12 条 JD 拆成一条一个文件。
 */
export function loadJsonCollection<T>(path: string): T[] {
  const st = statSync(path);
  if (st.isFile()) {
    const data = readJson<T[]>(path);
    if (!Array.isArray(data)) throw new Error(`${path} 不是数组`);
    return data;
  }
  const files = readdirSync(path)
    .filter((f) => f.endsWith('.json'))
    .sort();
  const out: T[] = [];
  for (const f of files) {
    const full = join(path, f);
    const data = readJson<T | T[]>(full);
    if (Array.isArray(data)) out.push(...data);
    else out.push(data);
  }
  return out;
}
