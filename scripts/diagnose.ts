/**
 * `npm run diagnose` —— 拿一份**真实简历**和一份**真实 JD**，跑一次诊断。
 *
 * 它与 `npm run eval` 的分工：
 *
 *   eval      造 24 组评测集 × 多档位 × 多次重复 → 回答"这个模型/这套 prompt 行不行"
 *   diagnose  你的简历 × 你的目标岗位 × 1 次      → 回答"我这份简历该怎么改"
 *
 * 两者共用同一个 Agent（`src/agent/offerAgent.ts`）和同一套指标纯函数
 * （`src/metrics/`），但产出物刻意分开：
 *   · 诊断**不写进评测集**（`data/cases/`），否则 24 组的统计口径就被一条真实简历污染了
 *   · 诊断记录落在 `data/live/`（gitignored），报告落在 `reports/diagnose-*.md`
 *
 * 为什么单条诊断也要算指标：不带出处、靠编具体数字撑起来的建议，看起来最像样。
 * 不把锚点覆盖率和无源实体率摆在旁边，人根本分不出哪条能信。
 *
 * 用法见 `src/diagnose/args.ts` 的 DIAGNOSE_USAGE（`npm run diagnose -- --help`）。
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { OfferAgent } from '../src/agent/offerAgent.js';
import {
  baselineRunId,
  defaultProfiles,
  formatPrice,
  type EvalProfile,
} from '../src/agent/catalog.js';
import { renderResume } from '../src/agent/prompts.js';
import type { GateEvidence } from '../src/agent/prompts.js';
import { DIAGNOSE_USAGE, parseDiagnoseArgs, type DiagnoseArgs } from '../src/diagnose/args.js';
import {
  renderMarkdown,
  renderTerminal,
  type DiagnoseReport,
  type GateRow,
  type SuggestionRow,
} from '../src/diagnose/report.js';
import { loadEnv } from '../src/lib/env.js';
import { isMainModule } from '../src/lib/entry.js';
import { segmentResume } from '../src/lib/resume-text.js';
import { anchorCoverage, hardGateCoverage } from '../src/metrics/anchor.js';
import { buildDict } from '../src/metrics/entities.js';
import { auditSuggestions, unsourcedRate } from '../src/metrics/unsourced.js';
import {
  EXPERIENCE_LABEL,
  JOB_CATEGORY_LABEL,
  type Case,
  type Jd,
  type Resume,
  type Suggestion,
} from '../src/schema/case.js';
import type { StepSpan } from '../src/schema/trace.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_LIVE = resolve(ROOT, 'data', 'live');
const REPORTS = resolve(ROOT, 'reports');

const LEVEL_LABEL: Record<Jd['level'], string> = {
  intern: '实习',
  junior: '初级',
  senior: '高级',
};

function readInput(path: string, label: string): string {
  const abs = resolve(path);
  if (!existsSync(abs)) {
    throw new Error(`${label} 文件不存在：${abs}\n  提示：路径相对「当前工作目录」，不是相对项目根目录`);
  }
  const text = readFileSync(abs, 'utf8');
  if (text.trim().length === 0) throw new Error(`${label} 文件是空的：${abs}`);
  return text;
}

/** 从 JD 首行取标题：取不到就退回文件名，绝不编一个像样的岗位名 */
function guessTitle(raw: string, path: string): string {
  const first = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0 && !/^#{1,6}\s*$/.test(l));
  if (first) {
    const clean = first.replace(/^#{1,6}\s*/, '').trim();
    if (clean.length > 0 && clean.length <= 60) return clean;
  }
  return path.split(/[\\/]/).pop() ?? '未命名岗位';
}

function pickProfile(args: DiagnoseArgs): EvalProfile {
  const profiles = defaultProfiles();
  if (args.profile !== null) {
    const hit = profiles.find((p) => p.run_id === args.profile);
    if (!hit) {
      throw new Error(
        `没有叫「${args.profile}」的档位。当前 key 下可用：\n` +
          profiles.map((p) => `  · ${p.run_id}（${p.model.label}）`).join('\n') +
          '\n  用 --list-profiles 也能看到这张表',
      );
    }
    return hit;
  }
  const id = baselineRunId(profiles);
  const hit = profiles.find((p) => p.run_id === id);
  if (!hit) throw new Error('默认档位为空，请用 --profile 指定');
  return hit;
}

function listProfiles(): void {
  const profiles = defaultProfiles();
  const envNote = profiles.some((p) => p.model.provider === 'siliconflow')
    ? '当前按 SILICONFLOW_API_KEY 选择档位'
    : profiles.some((p) => p.model.provider === 'deepseek')
      ? '当前按 DEEPSEEK_API_KEY 选择档位'
      : '当前没有任何 key，只能跑 --dry-run';
  console.log(`\n${envNote}。可用档位：\n`);
  for (const p of profiles) {
    const mark = p.run_id === baselineRunId(profiles) ? '（默认）' : '';
    console.log(`  ${p.run_id}${mark}`);
    console.log(`    ${p.model.label} · prompt ${p.prompt_version} · ${formatPrice(p.model)}`);
  }
  console.log('\n用法：--profile <run_id>\n');
}

/** 把 span 收敛成报告里那 4 行步骤（去掉根 span：它只是整次调用的壳） */
function stepsOf(spans: readonly StepSpan[]) {
  return spans
    .filter((s) => s.parent_id !== null)
    .map((s) => ({
      name: s.name,
      ms: Math.max(0, s.end - s.start),
      inputTokens: s.tokens?.input ?? 0,
      outputTokens: s.tokens?.output ?? 0,
      error: s.error ?? null,
    }));
}

async function main(): Promise<void> {
  const args = parseDiagnoseArgs(process.argv.slice(2));

  if (args.help) {
    console.log(DIAGNOSE_USAGE);
    return;
  }

  loadEnv(resolve(ROOT, '.env'));

  if (args.listProfiles) {
    listProfiles();
    return;
  }

  /* ---------- 输入 ---------- */
  const resumeRaw = readInput(args.resumePath, '简历');
  const jdRaw = readInput(args.jdPath, 'JD');

  const seg = segmentResume(resumeRaw);
  // 两个时间戳：`nowIso` 给 Date 解析用，`now` 给文件名用（带冒号的字符串在 Windows 上是非法文件名）
  const nowIso = new Date().toISOString();
  const now = nowIso.replace(/[:.]/g, '-').slice(0, 19);
  const caseId = `live-${now}`;

  const resume: Resume = {
    id: `live-resume-${now}`,
    anon_id: 'LIVE-01',
    headline: seg.headline,
    experience_level: args.experience,
    major_related: true,
    segments: seg.segments,
    skills: seg.skills,
    internships: [],
    projects: [],
  };

  const jd: Jd = {
    id: `live-jd-${now}`,
    title: args.title ?? guessTitle(jdRaw, args.jdPath),
    company_type: args.company,
    category: args.category,
    level: args.level,
    raw: jdRaw,
    // 刻意留空：真实 JD 没有人工标注。门槛由 Agent 第 1 步当场抽取，
    // 于是"门槛覆盖率"在这里只能做交叉校验，不能和评测集里的数字相加比较。
    hard_req: [],
    soft_req: [],
    source: 'real',
  };

  const c: Case = {
    id: caseId,
    dataset_version: 'live',
    resume_id: resume.id,
    jd_id: jd.id,
    tags: { category: args.category, experience_level: args.experience, level: args.level },
    is_hard_negative: false,
    is_golden: false,
  };

  /* ---------- dry-run：只做切分与预检 ---------- */
  if (args.dryRun) {
    const prompt = renderResume(resume);
    console.log(`\n=== 分段结果（${seg.segments.length} 段）===`);
    for (const s of seg.segments) console.log(`  ${s.seg_id}  ${s.text}`);
    if (seg.skills.length > 0) console.log(`\n识别到的技能：${seg.skills.join('、')}`);
    if (seg.headline.length > 0) console.log(`求职意向：${seg.headline}`);
    for (const w of seg.warnings) console.log(`⚠️  ${w}`);
    console.log(`\n=== 将发给模型的简历正文（${prompt.length} 字，粗估 ${Math.ceil(prompt.length / 1.7)} token）===`);
    console.log(prompt);
    console.log('\n=== dry-run：没有调用模型，没有花钱 ===');
    console.log('确认分段没问题后，去掉 --dry-run 再跑一次。');
    return;
  }

  /* ---------- 正式跑 ---------- */
  const profile = pickProfile(args);
  console.log(
    `档位 ${profile.run_id}（${profile.model.label} · ${profile.prompt_version}）` +
      `　简历 ${seg.segments.length} 段　重复 ${args.runs} 次`,
  );

  const agent = new OfferAgent(profile.model, profile.prompt_version);

  mkdirSync(resolve(DATA_LIVE, 'traces'), { recursive: true });
  mkdirSync(resolve(DATA_LIVE, 'inputs'), { recursive: true });
  mkdirSync(REPORTS, { recursive: true });

  const runsFile = resolve(DATA_LIVE, `runs-${now}.jsonl`);
  let suggestions: Suggestion[] = [];
  let gates: GateEvidence[] = [];
  let invalidAnchors: string[] = [];
  let hardReq: string[] = [];
  let inputTokens = 0;
  let outputTokens = 0;
  let costCny = 0;
  let latencyMs = 0;
  let spans: StepSpan[] = [];
  let lastError: string | null = null;

  for (let i = 0; i < args.runs; i++) {
    process.stdout.write(`  第 ${i + 1}/${args.runs} 次…`);
    const res = await agent.run(c, resume, jd, i);
    writeFileSync(
      resolve(DATA_LIVE, 'traces', `${profile.run_id}__${caseId}__r${i}.jsonl`),
      res.spans.map((s) => JSON.stringify(s)).join('\n') + '\n',
      'utf8',
    );
    appendFileSync(
      runsFile,
      JSON.stringify({
        run_id: profile.run_id,
        case_id: caseId,
        run_index: i,
        model: profile.model.id,
        prompt_version: profile.prompt_version,
        error: res.error,
        input_tokens: res.inputTokens,
        output_tokens: res.outputTokens,
        cost_cny: Number(res.costCny.toFixed(6)),
        latency_ms: res.latencyMs,
        invalid_anchors: res.invalidAnchors,
        suggestions: res.suggestions,
      }) + '\n',
      'utf8',
    );

    inputTokens += res.inputTokens;
    outputTokens += res.outputTokens;
    costCny += res.costCny;
    latencyMs += res.latencyMs;
    // 报告只展示第 1 次：多次之间本来就不该被"平均"掉，差异要人自己看
    if (i === 0) {
      suggestions = res.suggestions;
      gates = res.gates;
      invalidAnchors = res.invalidAnchors;
      hardReq = res.hardReq;
      spans = res.spans;
      lastError = res.error;
    }
    process.stdout.write(res.error ? ` 失败（${res.error}）\n` : ' 完成\n');
  }

  /* ---------- 指标（与批量评测同一套纯函数） ---------- */
  const dict = buildDict(resume, jd);
  const sourceText = [resume.segments.map((s) => s.text).join('\n'), jd.raw].join('\n');
  const verdicts = auditSuggestions(suggestions, sourceText, dict);
  const unsourced = unsourcedRate(verdicts);
  const anchors = anchorCoverage(suggestions);
  const strictGates = hardGateCoverage(suggestions, hardReq);

  const segText = new Map(resume.segments.map((s) => [s.seg_id, s.text]));
  const gateRows: GateRow[] = gates.map((g) => ({
    gate: g.gate,
    verdict: g.verdict,
    evidence: g.evidence_seg_ids,
    reason: g.reason,
  }));
  const suggestionRows: SuggestionRow[] = suggestions.map((s) => ({
    kind: s.kind,
    text: s.text,
    anchor: s.anchor_seg_id,
    anchorText: s.anchor_seg_id === null ? null : (segText.get(s.anchor_seg_id) ?? null),
  }));

  /* ---------- 输入快照：以后想复算锚点是否指对，得靠它 ---------- */
  const inputsFile = resolve(DATA_LIVE, 'inputs', `${caseId}.json`);
  writeFileSync(
    inputsFile,
    JSON.stringify({ case: c, resume, jd, generated_at: nowIso }, null, 2),
    'utf8',
  );

  const reportPath = resolve(REPORTS, `diagnose-${now}.md`);
  const report: DiagnoseReport = {
    generatedAt: nowIso,
    resumePath: resolve(args.resumePath),
    jdPath: resolve(args.jdPath),
    jdTitle: jd.title,
    categoryLabel: JOB_CATEGORY_LABEL[jd.category],
    levelLabel: LEVEL_LABEL[jd.level],
    experienceLabel: EXPERIENCE_LABEL[resume.experience_level],
    profile: {
      runId: profile.run_id,
      modelLabel: profile.model.label,
      promptVersion: profile.prompt_version,
    },
    runs: args.runs,
    segmentCount: resume.segments.length,
    warnings: seg.warnings,
    gates: gateRows,
    suggestions: suggestionRows,
    metrics: {
      anchorRate: anchors.rate,
      anchoredCount: anchors.anchoredCount,
      totalCount: anchors.totalCount,
      unsourcedRate: unsourced.rate,
      unsourcedTop: unsourced.topOffenders,
      invalidAnchors,
      strictGateRate: strictGates.rate,
      strictMissing: strictGates.missing,
    },
    cost: { cny: costCny, inputTokens, outputTokens, latencyMs },
    steps: stepsOf(spans),
    error: lastError,
    artifacts: {
      runsFile,
      inputsFile,
      reportPath,
    },
  };

  writeFileSync(reportPath, renderMarkdown(report), 'utf8');

  if (args.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    return;
  }
  console.log('');
  console.log(renderTerminal(report));
}

if (isMainModule(import.meta.url, process.argv[1])) {
  main().catch((err) => {
    console.error(`\n诊断失败：${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  });
}
