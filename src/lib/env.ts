/**
 * 极简 .env 读取 —— 不引 dotenv。
 *
 * 就 20 行的事，没必要为它增加一个依赖；
 * 而且自己写能明确控制"变量已存在时不覆盖"这个行为（CI 里注入的 key 优先级更高）。
 */

import { existsSync, readFileSync } from 'node:fs';

export interface LoadEnvResult {
  /** 实际加载进来的键 */
  loaded: string[];
  /** .env 文件是否存在 */
  found: boolean;
  path: string;
}

export function loadEnv(path: string): LoadEnvResult {
  if (!existsSync(path)) return { loaded: [], found: false, path };

  const loaded: string[] = [];
  const text = readFileSync(path, 'utf8');

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) continue;

    const eq = line.indexOf('=');
    if (eq <= 0) continue;

    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;

    let value = line.slice(eq + 1).trim();
    // 去掉包着的引号
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }

    // 已存在的环境变量优先 —— 便于用 CI 注入的凭证临时覆盖本地文件
    if (process.env[key] === undefined) {
      process.env[key] = value;
      loaded.push(key);
    }
  }

  return { loaded, found: true, path };
}
