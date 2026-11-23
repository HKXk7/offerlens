/**
 * `npm run jd:coverage` —— 打印 JD 库的覆盖度与数据质量。
 *
 * 存在的理由是：**缺口必须由平台自己说出来，而不是等别人发现。**
 * 一个在报告里混排 12 个档位、其中 3 格其实 0 条样本的平台，
 * 比一个诚实写下"这 3 格未覆盖"的平台更不专业。
 */

import { isMainModule } from '../src/lib/entry.js';
import { computeCoverage, renderCoverage } from '../src/jd/coverage.js';
import { DEFAULT_JD_PATH, loadJds } from '../src/jd/store.js';

function main(): void {
  const argv = process.argv.slice(2);
  if (argv.includes('-h') || argv.includes('--help')) {
    console.log(`用法：
  npm run jd:coverage           打印覆盖矩阵、缺口与数据质量
  npm run jd:coverage -- --json 以 JSON 输出（给脚本/CI 用）

数据源：${DEFAULT_JD_PATH}`);
    return;
  }

  const jds = loadJds();
  const cov = computeCoverage(jds);

  if (argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify(cov, null, 2)}\n`);
    return;
  }

  console.log(renderCoverage(cov));

  // 让 CI 能在"真实样本为 0"或"存在重复内容"时感知到退化。
  // 注意：缺口本身**不**让退出码非 0 —— 覆盖不全是一份待办清单，不是构建失败。
  if (cov.duplicates.length > 0) process.exitCode = 1;
  const realBad = cov.bySource.real.missingProvenance;
  if (realBad > 0) process.exitCode = 1;
}

if (isMainModule(import.meta.url, process.argv[1])) {
  try {
    main();
  } catch (err) {
    console.error(`\n读取 JD 库失败：${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}
