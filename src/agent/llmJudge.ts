/**
 * LLM 裁判：给建议的可执行性打分（1–3）。
 *
 * 三条防偏见措施都落在这里（对应 src/metrics/judge.ts 的注释）：
 *   1. 反偏见 prompt  —— 见 prompts.ts 的 judgeMessages
 *   2. 正反序各跑一次取平均 —— 治位置偏见，并留下两次的原始分用于诊断
 *   3. 长度相关检查    —— 把建议长度与得分做秩相关，>0.5 判定为"按长度打分"
 *
 * 还有一条不在这个文件里、但同样重要：
 *   **judge 模型必须与被测模型不同族**。这个由 catalog.ts 的 defaultJudge() 保证。
 */

import { costOf, PROVIDERS, resolveApiKey, type ModelSpec } from './catalog.js';
import { LlmClient } from './llm.js';
import { judgeMessages, type JudgeVerdict } from './prompts.js';
import { lengthBiasCorrelation } from '../metrics/judge.js';

export interface JudgeCallStats {
  inputTokens: number;
  outputTokens: number;
  costCny: number;
  attempts: number;
}

export interface JudgeRunResult {
  /** 与输入建议同序的最终分数（正反序平均） */
  scores: number[];
  stats: JudgeCallStats;
  latencyMs: number;
  error: string | null;
  /** 正序那次给的原始分 */
  forward: number[];
  /** 反序那次还原回原顺序后的分数 */
  backward: number[];
  /** 两次打分不一致（取整后不等）的条数 —— 位置偏见的直接证据 */
  disagreements: number;
  /** 长度与得分的秩相关，以及是否可疑 */
  lengthBias: { correlation: number; suspicious: boolean };
}

function toScores(verdict: JudgeVerdict, n: number): number[] {
  const out = new Array<number>(n).fill(2); // 缺项默认 2（中位），不默认 3 也不默认 1
  const list = Array.isArray(verdict?.scores) ? verdict.scores : [];
  for (const item of list) {
    const idx = typeof item?.index === 'number' ? item.index : -1;
    const score = typeof item?.score === 'number' ? Math.round(item.score) : NaN;
    if (idx >= 0 && idx < n && (score === 1 || score === 2 || score === 3)) {
      out[idx] = score;
    }
  }
  return out;
}

export interface JudgeOptions {
  /** 是否做正反序去偏。单条建议时没意义，会自动跳过 */
  orderDebias?: boolean;
}

export async function judgeSuggestions(
  model: ModelSpec,
  texts: readonly string[],
  opts: JudgeOptions = {},
): Promise<JudgeRunResult> {
  const started = Date.now();
  const client = new LlmClient({
    baseUrl: PROVIDERS[model.provider].baseUrl,
    apiKey: resolveJudgeKey(model),
    model: model.id,
    maxTokens: model.maxTokens,
    // 裁判模型同样要关思考：Hunyuan-A13B 默认常开，思考 token 按输出价计费，
    // 240 次裁判调用累起来不是小数。与生成侧同一个坑，同一个修法。
    extraBody: model.extraBody,
  });

  const stats: JudgeCallStats = { inputTokens: 0, outputTokens: 0, costCny: 0, attempts: 0 };
  const n = texts.length;
  const orderDebias = (opts.orderDebias ?? true) && n > 1;

  // 空样本下的"没发现偏见"。直接写常量，不要调 lengthBiasCorrelation([], []) ——
  // 那种写法会把"空数组"当成编程错误，反而在正常路径上炸掉。
  const emptyBias = { correlation: 0, suspicious: false };

  if (n === 0) {
    return {
      scores: [],
      stats,
      latencyMs: 0,
      error: null,
      forward: [],
      backward: [],
      disagreements: 0,
      lengthBias: emptyBias,
    };
  }

  /* ---------- 正序 ---------- */
  let forward: number[];
  try {
    const { data, usage } = await client.chatJson<JudgeVerdict>(judgeMessages(texts, true));
    forward = toScores(data, n);
    stats.inputTokens += usage.input_tokens;
    stats.outputTokens += usage.output_tokens;
    stats.attempts += usage.attempts;
    stats.costCny += costOf(model, usage.input_tokens, usage.output_tokens, usage.cached_input_tokens);
  } catch (err) {
    return {
      scores: [],
      stats,
      latencyMs: Date.now() - started,
      error: `judge 正序打分失败：${err instanceof Error ? err.message : String(err)}`,
      forward: [],
      backward: [],
      disagreements: 0,
      lengthBias: emptyBias,
    };
  }

  /* ---------- 反序（还原回原顺序） ---------- */
  let backward: number[] = forward.slice();
  if (orderDebias) {
    const reversed = texts.slice().reverse();
    try {
      const { data, usage } = await client.chatJson<JudgeVerdict>(judgeMessages(reversed, false));
      const revScores = toScores(data, n);
      backward = revScores.slice().reverse(); // 还原
      stats.inputTokens += usage.input_tokens;
      stats.outputTokens += usage.output_tokens;
      stats.attempts += usage.attempts;
      stats.costCny += costOf(model, usage.input_tokens, usage.output_tokens, usage.cached_input_tokens);
    } catch {
      // 反序失败不致命：用正序结果兜底，但 disagreements 记 -1 表示"没测成"
      backward = forward.slice();
      return {
        scores: forward,
        stats,
        latencyMs: Date.now() - started,
        error: 'judge 反序打分失败，已退化为只取正序',
        forward,
        backward,
        disagreements: -1,
        lengthBias: lengthBiasCorrelation(
          texts.map((t) => t.length),
          forward,
        ),
      };
    }
  }

  const scores = forward.map((f, i) => (f + backward[i]) / 2);
  const disagreements = forward.filter((f, i) => Math.round(f) !== Math.round(backward[i])).length;

  return {
    scores,
    stats,
    latencyMs: Date.now() - started,
    error: null,
    forward,
    backward,
    disagreements,
    lengthBias: lengthBiasCorrelation(
      texts.map((t) => t.length),
      scores,
    ),
  };
}

function resolveJudgeKey(model: ModelSpec): string {
  const { apiKey, missing } = resolveApiKey(model);
  if (missing) {
    const p = PROVIDERS[model.provider];
    throw new Error(
      `缺少裁判模型 ${p.label} 的 API Key。\n` +
        `  去 ${p.signupUrl} 注册，然后在 .env 里写 ${p.apiKeyEnv}=你的key`,
    );
  }
  return apiKey;
}
