/**
 * `npm run jd:add` —— 往 JD 库里加一条真实岗位。
 *
 * 为什么不做成"贴个链接自动抓"：
 * 招聘平台的页面会插入混淆水印（BOSS 直聘会往正文里塞 `kanzhun`、`boss` 字样），
 * 且页面结构随时变。自动抓取要同时解决反爬、登录态、水印清洗三件事，
 * 而这三件事跟"评测平台做得对不对"没有关系 —— 投入产出比极低，还带来合规风险。
 *
 * 所以入口刻意设计成**半自动**：人负责获取与判断（这份 JD 是不是真的、字段归类对不对），
 * 工具负责校验、去重、算指纹、保证格式一致。这也正是数据标注该有的分工。
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { isMainModule } from '../src/lib/entry.js';
import { computeCoverage } from '../src/jd/coverage.js';
import {
  JD_ADD_USAGE,
  JdArgsError,
  parseJdAddArgs,
} from '../src/jd/add-args.js';
import {
  JdConflictError,
  hashContent,
  loadJds,
  nextJdId,
  normalizeRaw,
  saveJds,
  upsertJd,
  validateJd,
} from '../src/jd/store.js';
import type { Jd } from '../src/schema/case.js';

function main(): void {
  const args = parseJdAddArgs(process.argv.slice(2));
  if (args.help) {
    console.log(JD_ADD_USAGE);
    return;
  }
  if (args.file === null) throw new JdArgsError('缺少 --file（JD 原文文件路径）');
  if (args.title === null) throw new JdArgsError('缺少 --title（岗位名称）');

  const raw = normalizeRaw(readFileSync(resolve(args.file), 'utf8'));
  const existing = loadJds();
  const id = args.id ?? nextJdId(existing, args.category, args.source);

  const jd: Jd = {
    id,
    title: args.title,
    company_type: args.companyType,
    category: args.category,
    level: args.level,
    source: args.source,
    content_hash: hashContent(raw),
    raw,
    hard_req: args.hardReq,
    soft_req: args.softReq,
  };

  if (args.source === 'real') {
    if (args.provenance === null || args.url === null) {
      // 参数解析已经拦过一次，这里再拦是因为"解析通过但字段没传进来"是可能的（比如别的调用方）
      throw new JdArgsError('source=real 需要 provenance 与 url');
    }
    jd.provenance = args.provenance;
    jd.collected_at = args.collectedAt ?? new Date().toISOString();
    jd.source_url = args.url;
  }

  const errors = validateJd(jd);
  if (errors.length > 0) {
    throw new JdArgsError(`这条 JD 不合法：\n  - ${errors.join('\n  - ')}`);
  }

  const result = upsertJd(existing, jd, { force: args.force });
  if (result.action === 'duplicate') {
    throw new JdArgsError(
      `内容与已有的「${result.duplicateOf}」完全相同（content_hash ${jd.content_hash}），` +
        '没有写入。同一岗位不用重复导入 —— 重复条目会让覆盖度统计虚高。',
    );
  }

  console.log(`${args.dryRun ? '【预检，不写文件】' : '已写入'} ${jd.id}`);
  console.log(`  标题    ${jd.title}（${jd.company_type}）`);
  console.log(`  归类    ${jd.category} / ${jd.level}`);
  console.log(
    `  来源    ${jd.source}` +
      (jd.provenance ? ` (${jd.provenance})` : '') +
      (jd.collected_at ? ` @ ${jd.collected_at}` : ''),
  );
  console.log(`  原文    ${raw.length} 字　指纹 ${jd.content_hash}`);
  console.log(`  硬门槛  ${jd.hard_req.length} 条${jd.hard_req.length > 0 ? `：${jd.hard_req.join('、')}` : '（已声明无门槛）'}`);
  console.log(`  软要求  ${jd.soft_req.length} 条`);
  console.log(`  动作    ${result.action === 'inserted' ? '新增' : '覆盖'}`);

  if (args.dryRun) {
    console.log('\n去掉 --dry-run 即写入 data/jd/jds.json');
    return;
  }

  saveJds(result.jds);
  const cov = computeCoverage(result.jds);
  console.log(
    `\nJD 库：${cov.total} 条（合成 ${cov.bySource.synthetic.count} · 真实 ${cov.bySource.real.count}）` +
      (cov.gaps.length > 0 ? `　仍有 ${cov.gaps.length} 格未覆盖，用 npm run jd:coverage 查看` : ''),
  );
}

if (isMainModule(import.meta.url, process.argv[1])) {
  try {
    main();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`\n导入失败：${msg}`);
    if (err instanceof JdConflictError) console.error('（重名但内容不同：确认覆盖请加 --force）');
    process.exitCode = 1;
  }
}
