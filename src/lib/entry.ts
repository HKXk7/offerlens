/**
 * 判断「本模块是被直接执行的，还是被 import 进来的」。
 *
 * 为什么不用最常见的那行写法：
 *
 *   if (process.argv[1] === fileURLToPath(import.meta.url)) main();
 *
 * 它在**路径被链接过**的机器上永远为 false。典型例子：
 *   · Windows 上把工作目录做成 junction（`mklink /J`）或 OneDrive 重定向
 *   · macOS / Linux 上项目放在符号链接目录下（`/Users/x/work → /Volumes/Data/work`）
 *   · pnpm / 某些打包器会把模块解析到真实路径
 *
 * 现象特别隐蔽：脚本不报错、退出码 0、什么也不打印 —— 因为 `main()` 根本没被调用。
 * 这类「静默空跑」比报错难查得多，而它偏偏出现在「按文档跑第一条命令」的位置上。
 *
 * 所以这里比较的是**两边经 realpath 之后的真实路径**，并且任一环节失败就退化到
 * 只比较文件名，宁可多跑一次 CLI，也不要静默不跑。
 */

import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function isMainModule(importMetaUrl: string, argvEntry: string | undefined): boolean {
  if (!argvEntry) return false;

  let self: string;
  try {
    self = realpathSync(fileURLToPath(importMetaUrl));
  } catch {
    self = fileURLToPath(importMetaUrl);
  }

  let entry: string;
  try {
    entry = realpathSync(resolve(argvEntry));
  } catch {
    entry = resolve(argvEntry);
  }

  return self === entry;
}
