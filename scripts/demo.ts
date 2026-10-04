/**
 * 端到端演示：不花一分钱，把整条管线跑通一遍。
 *
 *   cases.jsonl ──► 合成 Agent 输出 ──► 指标 ──► trace JSONL ──► SQLite ──► 对比矩阵 ──► Markdown 报告
 *
 * 为什么需要这个脚本：
 *   1. 真接模型之前，先把"数据 → 指标 → 对比 → 显著"这条链子验证通，
 *      否则 W3 会同时面对"模型不听话"和"管线不通"两件事。
 *   2. 它同时是面试时的演示底片：跑 `npm run demo` 五秒出结果，
 *      不用等你把 120 次调用跑完。
 *   3. 合成数据必须显式标注为合成 —— 报告末尾会写清楚这一点。
 *
 * 用法：npx tsx scripts/demo.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initDb } from '../src/db/init.js';
import { loadJsonCollection, readJsonl, writeJsonl } from '../src/lib/jsonl.js';
import { mulberry32, seedFromString, type Rng } from '../src/lib/prng.js';
import { buildDict, type EntityDict } from '../src/metrics/entities.js';
import { unsourcedRate, auditSuggestions } from '../src/metrics/unsourced.js';
import { anchorCoverage, hardGateCoverage } from '../src/metrics/anchor.js';
import { executability } from '../src/metrics/judge.js';
import { computeStepMetrics } from '../src/metrics/steps.js';
import { passK, stabilityBreakdown, type RunOutcome } from '../src/metrics/passk.js';
import {
  compareRuns,
  compareToMarkdown,
  sliceDown,
  sliceFindingsToMarkdown,
  partitionFindings,
  type RunRecord,
} from '../src/stats/compare.js';
import {
  type Case,
  type Jd,
  type Resume,
  type Suggestion,
} from '../src/schema/case.js';
import type { StepSpan } from '../src/schema/trace.js';
import { buildCases } from './build-cases.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'data/demo');

/* ================================================================== */
/* 1. 被测对象画像（用合成数据代替真实模型）                            */
/* ================================================================== */

interface ModelProfile {
  model: string;
  prompt_version: string;
  /** 建议挂上段 ID 锚点的概率 */
  anchorRate: number;
  /** 编造一个原文里没有的数字的概率 */
  fabricateRate: number;
  /** 可执行性基准分（1–3） */
  execBase: number;
  /** 单次成本（人民币） */
  cost: number;
  /** P95 延迟 */
  latency: number;
  /** 按岗位类别偏移的可执行性 —— 用来演示"整体持平但某个子集退化" */
  execByCategory?: Partial<Record<string, number>>;
}

const PROFILES: ModelProfile[] = [
  {
    model: 'modelA',
    prompt_version: 'p1-baseline',
    anchorRate: 0.6,
    fabricateRate: 0.55,
    execBase: 2.0,
    cost: 0.06,
    latency: 4200,
  },
  {
    model: 'modelB',
    prompt_version: 'p1-baseline',
    anchorRate: 0.92,
    fabricateRate: 0.08,
    execBase: 2.45,
    cost: 0.09,
    latency: 3800,
    // 平台类岗位反而明显变差 —— 这正是要挖出来的那个"整体更好但某子集退化"的坑
    execByCategory: { platform: -1.1 },
  },
  {
    model: 'modelA',
    prompt_version: 'p2-strict',
    anchorRate: 0.9,
    fabricateRate: 0.1,
    execBase: 2.6,
    cost: 0.08,
    latency: 4600,
  },
];

const BASE_PROFILE = PROFILES[0];

/* ================================================================== */
/* 2. 合成 Agent 输出                                                  */
/* ================================================================== */

const HIT_TEMPLATES = [
  (gate: string, seg: string) =>
    `${seg} 段的经历已经覆盖 ${gate}，建议把「参与」改成「负责」，并补上影响范围（多少人或多少时长）。`,
  (gate: string, seg: string) => `${seg} 段里写了 ${gate}，但只说了做了什么，建议补一句结果。`,
];

const MISSING_TEMPLATES = [
  (gate: string, seg: string) => `${seg} 段的技能里没有 ${gate}，建议补充一个用到 ${gate} 的小模块。`,
  (gate: string, seg: string) => `${seg} 段没有提到 ${gate}，建议补充相关经验并在项目里落地。`,
];

const FABRICATED = [
  () => '主导该项目并把整体效率提升了 47%，覆盖 3 个业务线。',
  () => '这段经历可以写成"服务 12 万日活用户，响应时间降低 63%"。',
  () => '建议补一句"带领 5 人小组完成交付，缺陷率下降 41%"。',
];

function synthesizeSuggestions(
  c: Case,
  resume: Resume,
  jd: Jd,
  profile: ModelProfile,
  runIndex: number,
): Suggestion[] {
  const rng = mulberry32(seedFromString(`${profile.model}|${profile.prompt_version}|${c.id}|${runIndex}`));
  const resumeText = resume.segments.map((s) => s.text).join('\n').toLowerCase();
  const suggestions: Suggestion[] = [];
  const gates = jd.hard_req.slice(0, 4);

  const skillsSeg =
    resume.segments.find((s) => s.text.includes('技能')) ?? resume.segments[0] ?? null;

  gates.forEach((gate, i) => {
    const seg = resume.segments.find((s) => s.text.toLowerCase().includes(gate.toLowerCase()));
    const anchored = rng.next() < profile.anchorRate;
    const text = seg
      ? HIT_TEMPLATES[i % HIT_TEMPLATES.length](gate, seg.seg_id)
      : MISSING_TEMPLATES[i % MISSING_TEMPLATES.length](gate, skillsSeg?.seg_id ?? '技能');
    // 缺失项锚到技能段：指出"你哪一段里没有这项"，而不是干说一句"建议补充"
    const anchorTarget = seg ?? skillsSeg;
    suggestions.push({
      id: `${profile.model}-${profile.prompt_version}-${c.id}-${i}`,
      case_id: c.id,
      run_id: `${profile.model}-${profile.prompt_version}`,
      run_index: runIndex,
      kind: seg ? 'hit' : 'missing',
      text,
      anchor_seg_id: anchored && anchorTarget ? anchorTarget.seg_id : null,
    });
  });

  // 编造：在末尾追加一条带凭空数字的建议 —— 这是"无源实体率"要抓的东西
  if (rng.next() < profile.fabricateRate) {
    suggestions.push({
      id: `${profile.model}-${profile.prompt_version}-${c.id}-fab`,
      case_id: c.id,
      run_id: `${profile.model}-${profile.prompt_version}`,
      run_index: runIndex,
      kind: 'improve',
      text: FABRICATED[rng.int(FABRICATED.length)](),
      anchor_seg_id: rng.next() < profile.anchorRate ? (resume.segments[0]?.seg_id ?? null) : null,
    });
  }
  return suggestions;
}

/* ================================================================== */
/* 3. 合成 trace                                                       */
/* ================================================================== */

const STEP_NAMES = ['parse_resume', 'extract_jd', 'match_gates', 'generate_report'];

function synthesizeTrace(
  c: Case,
  profile: ModelProfile,
  runIndex: number,
  passed: boolean,
  rng: Rng,
): StepSpan[] {
  const traceId = `${profile.model}-${profile.prompt_version}-${c.id}-${runIndex}`;
  const t0 = 1_760_000_000_000;
  const spans: StepSpan[] = [];
  const rootId = `${traceId}-root`;
  spans.push({
    span_id: rootId,
    parent_id: null,
    trace_id: traceId,
    type: 'agent',
    name: 'run_case',
    start: t0,
    end: t0 + profile.latency,
    tokens: null,
    attrs: { model: profile.model, prompt_version: profile.prompt_version, case_id: c.id },
  });

  let cursor = t0;
  STEP_NAMES.forEach((name, i) => {
    const dur = 300 + rng.int(600);
    spans.push({
      span_id: `${traceId}-llm-${i}`,
      parent_id: rootId,
      trace_id: traceId,
      type: 'llm',
      name,
      start: cursor,
      end: cursor + dur,
      tokens: { input: 3000 + rng.int(2000), output: 400 + rng.int(400) },
      attrs: { model: profile.model, input_digest: `${c.id}-${i}-${rng.int(2)}` },
    });
    cursor += dur;

    // 第 2 步挂一个工具调用；失败率与模型质量挂钩
    if (i === 1) {
      const failed = rng.next() < (passed ? 0.05 : 0.3);
      const toolId = `${traceId}-tool-0`;
      spans.push({
        span_id: toolId,
        parent_id: rootId,
        trace_id: traceId,
        type: 'tool',
        name: 'lookup_gate_dict',
        start: cursor,
        end: cursor + 120,
        tokens: null,
        error: failed ? 'timeout' : null,
        attrs: { input_digest: `${c.id}-gate` },
      });
      if (failed) {
        spans.push({
          span_id: `${traceId}-tool-0-retry`,
          parent_id: rootId,
          trace_id: traceId,
          type: 'tool',
          name: 'lookup_gate_dict',
          start: cursor + 130,
          end: cursor + 240,
          tokens: null,
          retry_of: toolId,
          error: null,
          attrs: { input_digest: `${c.id}-gate` },
        });
      }
      cursor += 260;
    }
  });

  // 一组特意放进来的死循环样本，用来验证检测器
  if (c.is_hard_negative) {
    for (let k = 0; k < 3; k++) {
      spans.push({
        span_id: `${traceId}-loop-${k}`,
        parent_id: rootId,
        trace_id: traceId,
        type: 'tool',
        name: 'rerun_extract',
        start: cursor + k * 50,
        end: cursor + k * 50 + 40,
        tokens: null,
        attrs: { input_digest: `${c.id}-loop` },
      });
    }
  }

  spans[0].end = Math.max(spans[0].end, cursor + 200);
  return spans;
}

/* ================================================================== */

interface CaseMetrics {
  case_id: string;
  unsourced: number;
  gateCoverage: number;
  anchorCoverage: number;
  execScore: number;
  passed: boolean;
}

function evaluateCase(
  c: Case,
  resume: Resume,
  jd: Jd,
  dict: EntityDict,
  suggestions: Suggestion[],
  profile: ModelProfile,
  rng: Rng,
): CaseMetrics {
  // "无源" = 简历里没有、JD 里也没有。两个输入文档都算"源"（见 run-eval.ts 的说明）
  const sourceText = [resume.segments.map((s) => s.text).join('\n'), jd.raw].join('\n');
  const unsourced = unsourcedRate(auditSuggestions(suggestions, sourceText, dict));
  const gates = hardGateCoverage(suggestions, jd.hard_req);
  const anchors = anchorCoverage(suggestions);

  const shift = profile.execByCategory?.[c.tags.category] ?? 0;
  const raw = profile.execBase + shift + (rng.next() - 0.5) * 0.6;
  const execScore = Math.min(3, Math.max(1, raw));

  // 判分规则写在代码里，不藏在脑子里：无源实体率 ≤15% 且硬门槛覆盖 ≥50% 才算达标
  const passed = unsourced.rate <= 0.15 && gates.rate >= 0.5;

  return {
    case_id: c.id,
    unsourced: unsourced.rate,
    gateCoverage: gates.rate,
    anchorCoverage: anchors.rate,
    execScore,
    passed,
  };
}

function main(): void {
  const jds = loadJsonCollection<Jd>(resolve(ROOT, 'data/jd'));
  const resumes = loadJsonCollection<Resume>(resolve(ROOT, 'data/resumes'));
  const resumeById = new Map(resumes.map((r) => [r.id, r]));
  const jdById = new Map(jds.map((j) => [j.id, j]));

  const { dataset, cases } = buildCases(resumes, jds, { seed: 20261004 });
  const rng = mulberry32(20261004);

  mkdirSync(OUT, { recursive: true });
  mkdirSync(resolve(ROOT, 'reports'), { recursive: true });

  const allRecords: RunRecord[] = [];
  const allOutcomes: RunOutcome[] = [];
  const perProfileMetrics = new Map<string, CaseMetrics[]>();

  for (const profile of PROFILES) {
    const runId = `${profile.model}__${profile.prompt_version}`;
    const metrics: CaseMetrics[] = [];
    const traceDir = resolve(OUT, 'traces');

    for (const c of cases) {
      const resume = resumeById.get(c.resume_id);
      const jd = jdById.get(c.jd_id);
      if (!resume || !jd) throw new Error(`case ${c.id} 引用了不存在的简历或 JD`);

      const dict = buildDict(resume, jd);
      for (let runIndex = 0; runIndex < 3; runIndex++) {
        const suggestions = synthesizeSuggestions(c, resume, jd, profile, runIndex);
        const m = evaluateCase(c, resume, jd, dict, suggestions, profile, rng);
        if (runIndex === 0) metrics.push(m);

        allOutcomes.push({ run_id: runId, case_id: c.id, run_index: runIndex, passed: m.passed });
        if (runIndex === 0) {
          allRecords.push({
            run_id: runId,
            case_id: c.id,
            run_index: 0,
            model: profile.model,
            prompt_version: profile.prompt_version,
            passed: m.passed,
            score: m.execScore,
            cost_usd: Number((profile.cost * (0.9 + rng.next() * 0.2)).toFixed(4)),
            latency_ms: profile.latency + Math.round((rng.next() - 0.5) * 600),
            unsourced_rate: m.unsourced,
            anchor_coverage: m.anchorCoverage,
            tags: c.tags,
          });
        }
        // 只给 golden + 难例写 trace：既够验证管线，又不会产生一堆垃圾文件
        if ((c.is_golden || c.is_hard_negative) && runIndex === 0) {
          const spans = synthesizeTrace(c, profile, runIndex, m.passed, rng);
          writeJsonl(resolve(traceDir, `${runId}__${c.id}.jsonl`), spans);
        }
      }
    }
    perProfileMetrics.set(runId, metrics);
  }

  /* ---------------- 指标汇总 ---------------- */
  console.log('\n=== 一、指标口径（合成数据，仅用于验证管线）===\n');
  console.log('配置'.padEnd(22) + '无源实体率  带锚点覆盖率  锚点覆盖率  可执行性  达标率');
  for (const [runId, metrics] of perProfileMetrics) {
    const avg = (f: (m: CaseMetrics) => number) => metrics.reduce((s, m) => s + f(m), 0) / metrics.length;
    console.log(
      runId.padEnd(22) +
        avg((m) => m.unsourced).toFixed(3).padEnd(12) +
        avg((m) => m.gateCoverage).toFixed(3).padEnd(14) +
        avg((m) => m.anchorCoverage).toFixed(3).padEnd(12) +
        avg((m) => m.execScore).toFixed(3).padEnd(10) +
        (metrics.filter((m) => m.passed).length / metrics.length).toFixed(3),
    );
  }
  console.log('\n判定规则（写在代码里，不藏在脑子里）：无源实体率 ≤ 15% 且硬门槛覆盖 ≥ 50% 记为达标。');

  /* ---------------- pass^3 ---------------- */
  console.log('\n=== 二、稳定性 ===\n');
  // pass^k 必须在同一配置内统计：三个模型的重复运行混在一起算出来的数字没有意义
  const baseRunId = `${BASE_PROFILE.model}__${BASE_PROFILE.prompt_version}`;
  const pkOverall = passK(
    allOutcomes.filter((o) => o.run_id === baseRunId),
    3,
  );
  for (const profile of PROFILES) {
    const runId = `${profile.model}__${profile.prompt_version}`;
    const subset = allOutcomes.filter((o) => o.run_id === runId);
    const pk = passK(subset, 3);
    const stab = stabilityBreakdown(subset, 3);
    console.log(
      `${runId.padEnd(22)} pass^3 = ${pk.rate.toFixed(3)}（${pk.passedCases}/${pk.eligibleCases}）· ` +
        `全过 ${stab.always} / 时好时坏 ${stab.flaky} / 全挂 ${stab.never} · 不稳定率 ${(stab.flakyRate * 100).toFixed(0)}%`,
    );
  }
  console.log('\n只看单次成功率是看不到"时好时坏"这一档的 —— 这正是 pass^k 存在的理由。');

  /* ---------------- 对比矩阵 ---------------- */
  const baseRecords = allRecords.filter(
    (r) => r.model === BASE_PROFILE.model && r.prompt_version === BASE_PROFILE.prompt_version,
  );

  let report = `# OfferLens 评测对比报告（合成数据）\n\n`;
  report += `> ⚠️ 本报告基于**合成数据**，用于验证指标与统计管线是否连通，**不能作为任何结论使用**。\n`;
  report += `> 评测集：${dataset.version} · 24 组 case · 基线：\`${BASE_PROFILE.model}\` / \`${BASE_PROFILE.prompt_version}\`\n\n`;

  console.log('\n=== 三、对比矩阵（基线 = modelA / p1-baseline）===\n');
  for (const profile of PROFILES) {
    if (profile === BASE_PROFILE) continue;
    const cand = allRecords.filter(
      (r) => r.model === profile.model && r.prompt_version === profile.prompt_version,
    );
    const row = compareRuns(baseRecords, cand);
    console.log(`— ${row.cand_model} / ${row.cand_prompt_version}`);
    for (const c of row.cells) {
      const sig =
        c.method === 'mcnemar'
          ? `McNemar p=${c.mcnemar?.p.toFixed(4)}`
          : `95%CI [${c.ci?.lo.toFixed(3)}, ${c.ci?.hi.toFixed(3)}]`;
      console.log(
        `   ${c.label.padEnd(18)} ${c.base.toFixed(3).padStart(8)} → ${c.cand
          .toFixed(3)
          .padStart(8)}  ${c.badge.padEnd(6)}  ${sig}`,
      );
    }
    report += `${compareToMarkdown(row, `${row.cand_model} / ${row.cand_prompt_version}`)}\n\n`;

    const findings = sliceDown(baseRecords, cand, ['experience_level', 'category']);
    const part = partitionFindings(findings);
    if (part.quality.length > 0) {
      console.log(`   ↓ 能力类切片差异（${part.quality.length} 条）：`);
      for (const f of part.quality) {
        console.log(
          `      ${f.slice_key}=${f.slice_value} (n=${f.n}) ${f.cell.label}: ${f.cell.base.toFixed(
            3,
          )} → ${f.cell.cand.toFixed(3)}  ${f.cell.badge}`,
        );
      }
    }
    if (part.resource.length > 0) {
      console.log(
        `   ↓ 资源类切片差异（成本/延迟，共 ${part.resource.length + part.resourceCollapsed} 条，展示前 ${part.resource.length} 条）：`,
      );
      for (const f of part.resource) {
        console.log(
          `      ${f.slice_key}=${f.slice_value} (n=${f.n}) ${f.cell.label}: ${f.cell.base.toFixed(
            3,
          )} → ${f.cell.cand.toFixed(3)}  ${f.cell.badge}`,
        );
      }
    }
    report += `${sliceFindingsToMarkdown(findings)}\n\n`;
  }

  /* ---------------- SQLite 落库，验证 schema ---------------- */
  const handle = initDb(resolve(ROOT, 'data/offerlens.db'), resolve(ROOT, 'schema/schema.sql'));
  const { db } = handle;
  db.prepare(
    'INSERT OR REPLACE INTO dataset (id, version, seed, created_at) VALUES (?, ?, ?, ?)',
  ).run(dataset.id, dataset.version, dataset.seed, dataset.created_at);

  const insRun = db.prepare(
    `INSERT OR REPLACE INTO eval_run
     (id, dataset_id, dataset_version, model, prompt_version, params_json, status,
      budget_limit_usd, spent_usd, seed, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, '{}', 'done', 100, ?, 42, ?, ?)`,
  );
  const now = new Date().toISOString();
  for (const profile of PROFILES) {
    const runId = `${profile.model}__${profile.prompt_version}`;
    insRun.run(runId, dataset.id, dataset.version, profile.model, profile.prompt_version, 0.09, now, now);
  }

  // 幂等写入：重复跑 demo 不会重复插入 —— 这就是 (run_id, case_id, run_index) 的作用
  const insResult = db.prepare(
    `INSERT OR IGNORE INTO result
     (run_id, case_id, run_index, output_json, scores_json, latency_ms, input_tokens, output_tokens,
      cost_usd, error_type, retry_count, cached, created_at)
     VALUES (?, ?, 0, '{}', ?, ?, 0, 0, ?, NULL, 0, 0, ?)`,
  );
  for (const r of allRecords) {
    insResult.run(
      r.run_id,
      r.case_id,
      JSON.stringify({ passed: r.passed, exec_score: r.score }),
      r.latency_ms,
      r.cost_usd,
      now,
    );
  }
  const resultCount = db.prepare('SELECT COUNT(*) AS c FROM result').get() as { c: number };
  const beforeCount = resultCount.c;
  for (const r of allRecords) {
    insResult.run(
      r.run_id,
      r.case_id,
      JSON.stringify({ passed: r.passed, exec_score: r.score }),
      r.latency_ms,
      r.cost_usd,
      now,
    );
  }
  const afterCount = (db.prepare('SELECT COUNT(*) AS c FROM result').get() as { c: number }).c;
  console.log(`\n=== 四、落库 ===\n`);
  console.log(`写入 result：${beforeCount} 行；再写一遍仍然是 ${afterCount} 行（幂等主键生效，重跑不会重复计费）`);

  // trace 摘要 + step 入库（只处理 golden case 的 trace）
  const insTrace = db.prepare(
    `INSERT OR REPLACE INTO trace
     (trace_id, run_id, case_id, run_index, status, steps_count, total_tokens, cost_usd, latency_ms, error_type, created_at)
     VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insStep = db.prepare(
    `INSERT OR REPLACE INTO step
     (span_id, trace_id, parent_id, type, name, start_ms, end_ms, input_tokens, output_tokens, retry_of, error, attrs_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  let traceCount = 0;
  let loopCases = 0;
  for (const profile of PROFILES) {
    const runId = `${profile.model}__${profile.prompt_version}`;
    for (const c of cases.filter((x) => x.is_golden || x.is_hard_negative)) {
      const file = resolve(OUT, 'traces', `${runId}__${c.id}.jsonl`);
      let spans: StepSpan[];
      try {
        spans = readJsonl<StepSpan>(file);
      } catch {
        continue;
      }
      const m = computeStepMetrics(spans);
      if (m.loops.length > 0) loopCases++;
      insTrace.run(
        spans[0].trace_id, runId, c.id, 'ok', m.spanCount, m.totalTokens,
        profile.cost, m.durationMs, null, now,
      );
      for (const s of spans) {
        insStep.run(
          s.span_id, s.trace_id, s.parent_id, s.type, s.name, s.start, s.end,
          s.tokens?.input ?? null, s.tokens?.output ?? null,
          s.retry_of ?? null, s.error ?? null, JSON.stringify(s.attrs ?? {}),
        );
      }
      traceCount++;
    }
  }
  console.log(`写入 trace ${traceCount} 条（golden + 难例）`);
  console.log(`其中检出死循环的 trace：${loopCases} 条`);

  /* ---------------- 报告 ---------------- */
  report += `\n## 附录：本报告的诚实说明\n\n`;
  report += `- 所有输出、trace、成本、延迟均为**合成数据**，由 \`scripts/demo.ts\` 按固定种子生成，目的是验证指标与统计管线。\n`;
  report += `- 判定规则：无源实体率 ≤ 15% 且带锚点的硬门槛覆盖率 ≥ 50% 记为达标。这条规则是**代理指标**，不等于"建议是对的"。\n`;
  report += `- pass^3（模型 A / p1-baseline）= ${pkOverall.rate.toFixed(3)}（${pkOverall.passedCases}/${pkOverall.eligibleCases}），按配置分别统计，不跨配置合并。\n`;
  report += `- 接入真实模型时，把 \`PROFILES\` 换成真实配置、把 \`synthesizeSuggestions\` 换成真实 Agent 输出即可，其余管线不动。\n`;
  writeFileSync(resolve(ROOT, 'reports/compare.md'), report, 'utf8');
  console.log(`\n报告已写入 reports/compare.md`);

  db.close();
}

main();
