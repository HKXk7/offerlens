/**
 * 入口守卫的回归测试。
 *
 * 背景（真实事故）：`scripts/build-cases.ts` 里用
 *   `resolve(process.argv[1]) === fileURLToPath(import.meta.url)`
 * 判断「是否被直接执行」。当工作目录被 junction / 符号链接过时（Windows 的 mklink /J、
 * OneDrive 重定向、macOS 的 /Volumes 挂载点等），`argv[1]` 是链接路径、
 * `import.meta.url` 是真实路径，两者字面值永不相等 ——
 * 于是 `main()` 从不被调用，脚本**不报错、退出码 0、什么也不打印**。
 *
 * 这种静默空跑比崩溃难查得多，而它偏偏出现在「按文档跑的第一条命令」上。
 */

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isMainModule } from '../src/lib/entry.js';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'offerlens-entry-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('isMainModule', () => {
  it('同一个文件的路径与 file URL 指向一致时为 true', () => {
    const file = resolve(tmp, 'a.ts');
    expect(isMainModule(pathToFileURL(file).href, file)).toBe(true);
  });

  it('不同文件为 false', () => {
    const self = resolve(tmp, 'a.ts');
    const other = resolve(tmp, 'b.ts');
    expect(isMainModule(pathToFileURL(self).href, other)).toBe(false);
  });

  it('argv[1] 缺失时为 false（而不是抛错）', () => {
    expect(isMainModule(pathToFileURL(resolve(tmp, 'a.ts')).href, undefined)).toBe(false);
  });

  it('不存在的路径不抛错', () => {
    const ghost = resolve(tmp, 'ghost.ts');
    expect(() => isMainModule(pathToFileURL(ghost).href, ghost)).not.toThrow();
  });

  /**
   * 核心用例：经符号链接访问同一个文件时，必须仍判定为「直接执行」。
   * 这条对应的就是让 `npm run cases:build` 静默空跑的那个场景。
   */
  it('经符号链接访问同一文件时仍为 true（就是静默空跑的那个 bug）', () => {
    const realDir = join(tmp, 'real');
    const linkDir = join(tmp, 'link');
    mkdirSync(realDir);
    const realFile = join(realDir, 's.ts');
    writeFileSync(realFile, '// noop\n');

    try {
      // Windows 上建目录联接（junction）不需要管理员权限；Linux/macOS 用普通符号链接
      symlinkSync(realDir, linkDir, process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      // 某些 CI / 受限环境禁止建链接 —— 直接跳过，而不是让整条流水线变红
      return;
    }

    const viaLink = join(linkDir, 's.ts');
    // 字面值不相等，这正是 bug 的成因
    expect(resolve(viaLink)).not.toBe(resolve(realFile));
    // 但 realpath 之后必须判定为同一个入口
    expect(isMainModule(pathToFileURL(realFile).href, viaLink)).toBe(true);
  });
});
