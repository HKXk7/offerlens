/**
 * 生成合成评测数据，让 Web 控制台在没有 API key 时也能看到「有数据的榜单 + 对比」。
 *
 * 为什么需要它：
 *   data/real/ 里的真实评测结果被 gitignore（含简历与建议原文），
 *   别人 clone 下来跑 `npm run serve` 会看到一张空榜 —— 这对"clone 就能用"是致命的。
 *   本脚本用与 demo.ts 同一套合成思路，把「建议 + 锚点 + 偶尔编造」写进
 *   data/demo/runs.jsonl + judge.jsonl，analyze.ts 在 data/real 为空时自动回退到这里。
 *
 * 数据是**合成**的（固定种子，可复现），UI 里通过 run_id 的 `demo-` 前缀可辨。
 *
 * 用法：npx tsx scripts/seed-demo-runs.ts
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadJsonCollection } from '../src/lib/jsonl.js';
import { mulberry32, seedFromString } from '../src/lib/prng.js';
import { buildCases } from './build-cases.js';
import type { Jd, Resume, Suggestion } from '../src/schema/case.js';
import type { StepSpan } from '../src/schema/trace.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'data', 'demo');

interface DemoProfile {
  run_id: string;
  model: string;
  prompt_version: string;
  anchorRate: number;
  fabricateRate: number;
  execBase: number;
  costCny: number;
  latencyMs: number;
  /** 无产出概率（演示"产出率是前置门槛"这条结论） */
  emptyRate: number;
  /** 按岗位类别偏移的可执行性 —— 演示"整体持平但某子集退化" */
  execByCategory?: Partial<Record<string, number>>;
}

const PROFILES: DemoProfile[] = [
  {
    run_id: 'demo-flash__p2-strict',
    model: 'deepseek-ai/DeepSeek-V4-Flash',
    prompt_version: 'p2-strict',
    anchorRate: 0.75,
    fabricateRate: 0.4,
    execBase: 2.8,
    costCny: 0.013,
    latencyMs: 9500,
    emptyRate: 0.02,
  },
  {
    run_id: 'demo-qwen__p2-strict',
    model: 'Qwen/Qwen3.5-122B-A10B',
    prompt_version: 'p2-strict',
    anchorRate: 0.95,
    fabricateRate: 0.08,
    execBase: 2.9,
    costCny: 0.007,
    latencyMs: 11200,
    emptyRate: 0.02,
    // 平台类岗位反而明显变差 —— 这就是要挖出来的"整体更好但某子集退化"的坑
    execByCategory: { platform: -1.0 },
  },
  {
    run_id: 'demo-glm__p2-strict',
    model: 'zai-org/GLM-4.5-Air',
    prompt_version: 'p2-strict',
    anchorRate: 0.9,
    fabricateRate: 0.05,
    execBase: 2.75,
    costCny: 0.004,
    latencyMs: 8200,
    emptyRate: 0.42, // 大量运行产不出结构化结果 —— 对应 GLM-4.5-Air 的实测行为
  },
];

const HIT_TEMPLATES = [
  (gate: string, seg: string) => `${seg} 段的经历已经覆盖 ${gate}，建议把「参与」改成「负责」，并补上影响范围。`,
  (gate: string, seg: string) => `${seg} 段里写了 ${gate}，但只说了做了什么，建议补一句可量化的结果。`,
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

function synthesize(
  profile: DemoProfile,
  c: { id: string; resume_id: string; jd_id: string },
  resume: Resume,
  jd: Jd,
  runIndex: number,
): Suggestion[] {
  const rng = mulberry32(seedFromString(`${profile.run_id}|${c.id}|${runIndex}`));
  if (rng.next() < profile.emptyRate) return []; // 无产出：模拟模型报错/返回空

  const skillsSeg = resume.segments.find((s) => s.text.includes('技能')) ?? resume.segments[0] ?? null;
  const suggestions: Suggestion[] = [];
  const gates = jd.hard_req.slice(0, 4);

  gates.forEach((gate, i) => {
    const seg = resume.segments.find((s) => s.text.toLowerCase().includes(gate.toLowerCase()));
    const text = seg
      ? HIT_TEMPLATES[i % HIT_TEMPLATES.length](gate, seg.seg_id)
      : MISSING_TEMPLATES[i % MISSING_TEMPLATES.length](gate, skillsSeg?.seg_id ?? '技能');
    const anchorTarget = seg ?? skillsSeg;
    const anchored = rng.next() < profile.anchorRate;
    suggestions.push({
      id: `${profile.run_id}-${c.id}-${i}`,
      case_id: c.id,
      run_id: profile.run_id,
      run_index: runIndex,
      kind: seg ? 'hit' : 'missing',
      text,
      anchor_seg_id: anchored && anchorTarget ? anchorTarget.seg_id : null,
    });
  });

  if (rng.next() < profile.fabricateRate) {
    suggestions.push({
      id: `${profile.run_id}-${c.id}-fab`,
      case_id: c.id,
      run_id: profile.run_id,
      run_index: runIndex,
      kind: 'improve',
      text: FABRICATED[rng.int(FABRICATED.length)](),
      anchor_seg_id: rng.next() < profile.anchorRate ? (resume.segments[0]?.seg_id ?? null) : null,
    });
  }
  return suggestions;
}

/** 固定的合成时间基准（与真实 trace 同量级的 epoch 毫秒），保证生成可复现。 */
const T0 = 1791109000000;

/**
 * 合成一次运行的 4 步 trace（与 offerAgent 的真实结构一致）：
 *   agent(root) → analyze_jd(llm) → analyze_resume(llm) → gate_match(tool) → generate(llm)
 * 无产出时，generate 步标 error —— 对应「产不出结构化结果」的实测行为。
 */
function synthesizeTrace(
  profile: DemoProfile,
  caseId: string,
  runIndex: number,
  inputTokens: number,
  outputTokens: number,
  empty: boolean,
): StepSpan[] {
  const traceId = `${profile.run_id}__${caseId}__r${runIndex}`;
  const latency = profile.latencyMs;
  const t0 = T0 + runIndex * 1_000_000;
  const rootId = `${traceId}-root`;
  const err = empty ? 'generate 未产出任何有效建议' : null;

  // 三步 llm 时间切分：analyze_jd 输出最多、耗时最长
  const s1 = t0;
  const s2 = t0 + latency * 0.45;
  const s3 = t0 + latency * 0.65;
  const s4 = t0 + latency * 0.66;
  const s5 = t0 + latency;

  const jdIn = Math.round(inputTokens * 0.4);
  const resumeIn = Math.round(inputTokens * 0.25);
  const genIn = inputTokens - jdIn - resumeIn;
  const jdOut = empty ? 0 : Math.round(outputTokens * 0.55);
  const resumeOut = empty ? 0 : Math.round(outputTokens * 0.2);
  const genOut = empty ? 0 : outputTokens - jdOut - resumeOut;

  const mk = (
    index: number,
    type: StepSpan['type'],
    name: string,
    start: number,
    end: number,
    tokens: { input: number; output: number } | null,
    spanErr: string | null,
    attrs: Record<string, unknown>,
  ): StepSpan => ({
    span_id: `${traceId}-${index}`,
    parent_id: index === 0 ? null : rootId,
    trace_id: traceId,
    type,
    name,
    start,
    end,
    tokens,
    error: spanErr,
    attrs: { model: profile.model, prompt_version: profile.prompt_version, ...attrs },
  });

  return [
    mk(0, 'agent', 'run_case', t0, s5, null, err, { case_id: caseId, run_index: runIndex }),
    mk(1, 'llm', 'analyze_jd', s1, s2, { input: jdIn, output: jdOut }, null, { hard_req_count: 4, attempt: 1 }),
    mk(2, 'llm', 'analyze_resume', s2, s3, { input: resumeIn, output: resumeOut }, null, { gate_count: 4, attempt: 1 }),
    mk(3, 'tool', 'gate_match', s3, s4, null, null, { gates: 4, hit: 2, missing: 2, invalid_evidence_ids: 0 }),
    mk(4, 'llm', 'generate', s4, s5, { input: genIn, output: genOut }, err, { attempt: 1 }),
  ];
}

function main(): void {
  const jds = loadJsonCollection<Jd>(resolve(ROOT, 'data', 'jd'));
  const resumes = loadJsonCollection<Resume>(resolve(ROOT, 'data', 'resumes'));
  const resumeById = new Map(resumes.map((r) => [r.id, r]));
  const jdById = new Map(jds.map((j) => [j.id, j]));

  const { cases } = buildCases(resumes, jds, { seed: 20261004 });

  const traceDir = resolve(OUT, 'traces');
  mkdirSync(OUT, { recursive: true });
  // 清掉旧 trace（避免与当前 demo run_id 不匹配的残留），重新生成
  rmSync(traceDir, { recursive: true, force: true });
  mkdirSync(traceDir, { recursive: true });

  const runsLines: string[] = [];
  const judgeLines: string[] = [];

  for (const profile of PROFILES) {
    for (const c of cases) {
      const resume = resumeById.get(c.resume_id);
      const jd = jdById.get(c.jd_id);
      if (!resume || !jd) continue;

      const shift = profile.execByCategory?.[c.tags.category] ?? 0;
      for (let runIndex = 0; runIndex < 3; runIndex++) {
        const rng = mulberry32(seedFromString(`${profile.run_id}|${c.id}|${runIndex}|r`));
        const suggestions = synthesize(profile, c, resume, jd, runIndex);
        const empty = suggestions.length === 0;
        const inputTokens = 1800 + rng.int(400);
        const outputTokens = empty ? 0 : 900 + rng.int(600);

        runsLines.push(
          JSON.stringify({
            run_id: profile.run_id,
            case_id: c.id,
            run_index: runIndex,
            model: profile.model,
            prompt_version: profile.prompt_version,
            error: empty ? 'generate 未产出任何有效建议' : null,
            input_tokens: inputTokens,
            output_tokens: outputTokens,
            cost_cny: Number((profile.costCny * (0.85 + rng.next() * 0.3)).toFixed(6)),
            latency_ms: profile.latencyMs + Math.round((rng.next() - 0.5) * 800),
            invalid_anchors: [],
            suggestions,
          }),
        );

        // 合成 4 步 trace（供 case 详情页的瀑布图）
        const spans = synthesizeTrace(profile, c.id, runIndex, inputTokens, outputTokens, empty);
        writeFileSync(
          resolve(traceDir, `${profile.run_id}__${c.id}__r${runIndex}.jsonl`),
          spans.map((s) => JSON.stringify(s)).join('\n') + '\n',
          'utf8',
        );
      }

      // 裁判：可执行性 1–3，围绕 execBase + 类别偏移抖动
      const jrng = mulberry32(seedFromString(`${profile.run_id}|${c.id}|judge`));
      const n = Math.max(3, 4);
      const scores = Array.from({ length: n }, () => {
        const raw = profile.execBase + shift + (jrng.next() - 0.5) * 0.6;
        return Math.round(Math.min(3, Math.max(1, raw)));
      });
      judgeLines.push(
        JSON.stringify({
          run_id: profile.run_id,
          case_id: c.id,
          judge_model: 'tencent/Hunyuan-A13B-Instruct',
          scores,
          cost_cny: 0.0004,
          disagreements: 0,
          correlation: 0.12,
          error: null,
        }),
      );
    }
  }

  writeFileSync(resolve(OUT, 'runs.jsonl'), runsLines.join('\n') + '\n', 'utf8');
  writeFileSync(resolve(OUT, 'judge.jsonl'), judgeLines.join('\n') + '\n', 'utf8');

  console.log(`✅ 合成演示数据已写入 data/demo/`);
  console.log(`   runs.jsonl  ${runsLines.length} 行（${PROFILES.length} 档位 × ${cases.length} 组 × 3 次）`);
  console.log(`   judge.jsonl ${judgeLines.length} 行`);
  console.log(`   traces/     ${runsLines.length} 个 4 步 trace（供 case 详情瀑布图）`);
  console.log(`   档位：${PROFILES.map((p) => p.run_id).join(' / ')}`);
  console.log(`   ⚠️ 全部为合成数据，仅用于在无 API key 时演示控制台。`);
}

main();
