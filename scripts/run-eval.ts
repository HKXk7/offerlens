/**
 * 真实模型评测运行器 —— CLI 入口（薄封装）。
 *
 * 核心逻辑在 `src/eval/runner.ts` 的 `runEval()`，CLI 与 Web 控制台共用同一份。
 * 这个文件只做两件事：
 *   1. 把命令行参数解析成结构化的 `EvalOptions`
 *   2. 把 `runEval` 发出的日志/进度事件渲染成终端输出（保持与历史一致的输出格式）
 *
 * 用法：
 *   npx tsx scripts/run-eval.ts --dry-run          # 只打印第一条 prompt，不发请求（先确认没问题）
 *   npx tsx scripts/run-eval.ts --limit 4          # 冒烟：只跑 4 组 case
 *   npx tsx scripts/run-eval.ts                    # 全量：24 组 × 3 档位 × 3 次重复
 *   npx tsx scripts/run-eval.ts --runs 1           # 只跑 1 次（不做 pass^k）
 *   npx tsx scripts/run-eval.ts --no-judge         # 跳过 LLM 裁判（可执行性指标留空）
 *   npx tsx scripts/run-eval.ts --profile flash__p1-baseline,flash__p2-strict   # 只跑指定档位（逗号分隔）
 *   npx tsx scripts/run-eval.ts --budget 100       # 预算硬上限（元），超了立刻停
 *   npx tsx scripts/run-eval.ts --report-only      # 只按已落盘数据重新出报告，不花钱、不重跑
 *
 * 中断了直接重跑就行：已完成的 (run_id, case_id, run_index) 会跳过。
 */
import { runEval, type Emit, type EvalOptions } from '../src/eval/runner.js';

/* ------------------------------------------------------------------ */
/* 参数解析                                                            */
/* ------------------------------------------------------------------ */

interface Args {
  dryRun: boolean;
  limit: number | null;
  runs: number;
  judge: boolean;
  budget: number;
  concurrency: number;
  profileFilter: string | null;
  reportOnly: boolean;
}

function parseArgs(argv: readonly string[]): Args {
  const get = (flag: string): string | null => {
    const i = argv.indexOf(flag);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
  };
  const num = (flag: string, dflt: number): number => {
    const v = get(flag);
    if (v === null) return dflt;
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`${flag} 需要正数，收到 ${v}`);
    return n;
  };
  return {
    dryRun: argv.includes('--dry-run'),
    limit: get('--limit') === null ? null : num('--limit', 0),
    runs: num('--runs', 3),
    judge: !argv.includes('--no-judge'),
    budget: num('--budget', 100),
    concurrency: num('--concurrency', 4),
    profileFilter: get('--profile'),
    reportOnly: argv.includes('--report-only'),
  };
}

/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  // 把事件渲染成终端输出。进度行用 \r 原地刷新，接日志前自动换行。
  let lastWasProgress = false;
  const emit: Emit = (e) => {
    if (e.type === 'log') {
      if (lastWasProgress) process.stdout.write('\n');
      lastWasProgress = false;
      process.stdout.write(e.line + '\n');
    } else if (e.type === 'progress') {
      const p = e.progress;
      lastWasProgress = true;
      if (p.phase === 'generating') {
        process.stdout.write(
          `\r  进度 ${p.completed}/${p.total}　已花 ¥${p.spentCny.toFixed(2)}　` +
            `剩余 ¥${p.remainingCny.toFixed(2)}${p.hasFailure ? '　(有失败)' : ''}   `,
        );
      } else {
        process.stdout.write(`\r  已裁判 ${p.completed}/${p.total}　已花 ¥${p.spentCny.toFixed(2)}   `);
      }
    } else if (e.type === 'done') {
      if (lastWasProgress) process.stdout.write('\n');
      lastWasProgress = false;
    }
  };

  const opts: EvalOptions = {
    profiles: args.profileFilter
      ? args.profileFilter
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s.length > 0)
      : null,
    limit: args.limit,
    runs: args.runs,
    judge: args.judge,
    budget: args.budget,
    concurrency: args.concurrency,
    dryRun: args.dryRun,
    reportOnly: args.reportOnly,
  };

  await runEval(opts, emit);
}

main().catch((err) => {
  console.error('\n运行失败：', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
