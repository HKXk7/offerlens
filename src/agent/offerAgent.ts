/**
 * 内层被测对象：简历诊断 Agent。
 *
 * 4 步，其中 3 次模型调用 + 1 次确定性工具调用：
 *
 *   1. analyze_jd      (llm)  从 JD 原文抽硬性/软性要求
 *   2. analyze_resume  (llm)  逐条在简历里找证据，回填段 ID
 *   3. gate_match      (tool) 确定性归一与去重 —— 不花 token 的事交给代码
 *   4. generate        (llm)  产出建议，绑定 anchor_seg_id
 *
 * 为什么拆成 4 步而不是一个大 prompt：
 *   · 拆开才能在 trace 里看见"是哪一步坏了"——一个大 prompt 出错时无从定位
 *   · 第 3 步用代码做，省 token 且结果确定
 *   · pass^k 的"时好时坏"往往就来自第 2 步的判定抖动，拆开才看得到
 *
 * ⚠️ 一个容易被忽略但很关键的校验：**模型回填的段 ID 必须真实存在**。
 *    模型很擅长编一个 "S09" 出来冒充有出处。若直接采信，
 *    "带锚点覆盖率"这个指标会被假锚点灌水。所以这里把不存在的段 ID 一律置 null，
 *    同时单独记进 invalidAnchors 供人工复核。
 */

import type { Case, Jd, Resume, Suggestion } from '../schema/case.js';
import type { StepSpan, TokenUsage } from '../schema/trace.js';
import { costOf, PROVIDERS, resolveApiKey, type ModelSpec, type PromptVersion } from './catalog.js';
import { LlmClient } from './llm.js';
import {
  generateMessages,
  jdAnalysisMessages,
  resumeAnalysisMessages,
  type GateEvidence,
  type JdAnalysis,
  type ResumeAnalysis,
} from './prompts.js';

export interface AgentRunResult {
  suggestions: Suggestion[];
  spans: StepSpan[];
  inputTokens: number;
  outputTokens: number;
  costCny: number;
  latencyMs: number;
  error: string | null;
  /** 模型回填了但简历里不存在的段 ID —— 属于"假装有出处"，必须单独暴露 */
  invalidAnchors: string[];
  /** 解析 JD 得到的硬性要求（落库后可用于交叉检查） */
  hardReq: string[];
}

interface RawSuggestion {
  kind?: string;
  text?: string;
  anchor_seg_id?: string | null;
}

interface RawGeneration {
  suggestions?: RawSuggestion[];
}

const VALID_KINDS = new Set(['improve', 'missing', 'hit']);

function digest(s: string, keep = 120): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length <= keep ? flat : `${flat.slice(0, keep)}…`;
}

export class OfferAgent {
  private readonly client: LlmClient;

  constructor(
    private readonly model: ModelSpec,
    private readonly promptVersion: PromptVersion,
    client?: LlmClient,
  ) {
    this.client =
      client ??
      new LlmClient({
        baseUrl: resolveBaseUrl(model),
        apiKey: resolveKey(model),
        model: model.id,
        // 显式输出上限：不传就等于交给服务端默认值（硅基流动是 4096），
        // Ling-flash-2.0 会在那里被截断，JSON 永远不完整。
        maxTokens: model.maxTokens,
        // ⚠️ 必须透传。catalog 里给每个模型声明了关思考参数
        //（Qwen3.5 用 enable_thinking，GLM/DeepSeek-V4-Flash 用 thinking），
        // 但这里早先漏了这一行 —— 参数声明了却永远送不到请求体里，
        // 于是 Qwen3.5 一次诊断会额外输出上千 token 的思维链，成本直接翻倍。
        extraBody: model.extraBody,
      });
  }

  async run(c: Case, resume: Resume, jd: Jd, runIndex: number): Promise<AgentRunResult> {
    const runId = `${this.model.id}__${this.promptVersion}`;
    const traceId = `${runId}__${c.id}__r${runIndex}`;
    const startedAt = Date.now();
    const t0 = startedAt;
    const spans: StepSpan[] = [];
    const strict = this.promptVersion === 'p2-strict';

    let inputTokens = 0;
    let outputTokens = 0;
    let costCny = 0;

    const rootId = `${traceId}-root`;
    const rootSpan: StepSpan = {
      span_id: rootId,
      parent_id: null,
      trace_id: traceId,
      type: 'agent',
      name: 'run_case',
      start: t0,
      end: t0,
      tokens: null,
      error: null,
      attrs: {
        model: this.model.id,
        prompt_version: this.promptVersion,
        case_id: c.id,
        run_index: runIndex,
      },
    };
    spans.push(rootSpan);

    const finish = (
      suggestions: Suggestion[],
      error: string | null,
      invalidAnchors: string[],
      hardReq: string[],
    ): AgentRunResult => {
      rootSpan.end = Date.now();
      rootSpan.error = error;
      return {
        suggestions,
        spans,
        inputTokens,
        outputTokens,
        costCny,
        latencyMs: rootSpan.end - t0,
        error,
        invalidAnchors,
        hardReq,
      };
    };

    const record = (
      index: number,
      type: 'llm' | 'tool',
      name: string,
      start: number,
      end: number,
      tokens: TokenUsage | null,
      attrs: Record<string, unknown>,
      error: string | null,
    ): void => {
      spans.push({
        span_id: `${traceId}-${index}`,
        parent_id: rootId,
        trace_id: traceId,
        type,
        name,
        start,
        end,
        tokens,
        error,
        attrs: { model: this.model.id, prompt_version: this.promptVersion, ...attrs },
      });
    };

    /* ---------- Step 1：解析 JD ---------- */
    const s1 = Date.now();
    let jdAnalysis: JdAnalysis;
    try {
      const { data, usage } = await this.client.chatJson<JdAnalysis>(jdAnalysisMessages(jd));
      jdAnalysis = {
        hard_req: Array.isArray(data.hard_req) ? data.hard_req.filter((x) => typeof x === 'string') : [],
        soft_req: Array.isArray(data.soft_req) ? data.soft_req.filter((x) => typeof x === 'string') : [],
      };
      inputTokens += usage.input_tokens;
      outputTokens += usage.output_tokens;
      costCny += costOf(this.model, usage.input_tokens, usage.output_tokens, usage.cached_input_tokens);
      record(1, 'llm', 'analyze_jd', s1, Date.now(), {
        input: usage.input_tokens,
        output: usage.output_tokens,
      }, { hard_req_count: jdAnalysis.hard_req.length, attempt: usage.attempts }, null);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      record(1, 'llm', 'analyze_jd', s1, Date.now(), null, {}, msg);
      return finish([], `analyze_jd 失败：${msg}`, [], []);
    }

    if (jdAnalysis.hard_req.length === 0) {
      // JD 一条硬要求都抽不出来 = 这一步实际已经废了，继续跑只会产出无意义建议
      record(2, 'tool', 'gate_match', Date.now(), Date.now(), null, { empty: true }, 'JD 未解析出任何硬性要求');
      return finish([], 'analyze_jd 未产出任何硬性要求', [], []);
    }

    /* ---------- Step 2：在简历里找证据 ---------- */
    const s2 = Date.now();
    let analysis: ResumeAnalysis;
    try {
      const { data, usage } = await this.client.chatJson<ResumeAnalysis>(
        resumeAnalysisMessages(resume, jdAnalysis, strict),
      );
      analysis = { gates: Array.isArray(data.gates) ? data.gates : [] };
      inputTokens += usage.input_tokens;
      outputTokens += usage.output_tokens;
      costCny += costOf(this.model, usage.input_tokens, usage.output_tokens, usage.cached_input_tokens);
      record(2, 'llm', 'analyze_resume', s2, Date.now(), {
        input: usage.input_tokens,
        output: usage.output_tokens,
      }, { gate_count: analysis.gates.length, attempt: usage.attempts }, null);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      record(2, 'llm', 'analyze_resume', s2, Date.now(), null, {}, msg);
      return finish([], `analyze_resume 失败：${msg}`, [], jdAnalysis.hard_req);
    }

    /* ---------- Step 3：确定性归一（tool，不花 token） ---------- */
    const s3 = Date.now();
    const segIds = new Set(resume.segments.map((s) => s.seg_id));
    const validGates: GateEvidence[] = [];
    const invalidEvidence: string[] = [];
    const seen = new Set<string>();
    for (const g of analysis.gates) {
      if (typeof g?.gate !== 'string' || g.gate.trim().length === 0) continue;
      const key = g.gate.trim();
      if (seen.has(key)) continue; // 模型有时会重复输出同一条要求
      seen.add(key);
      const verdict = (['hit', 'partial', 'missing'] as const).includes(g.verdict)
        ? g.verdict
        : 'missing';
      let evidence = Array.isArray(g.evidence_seg_ids)
        ? g.evidence_seg_ids.filter((x) => typeof x === 'string')
        : [];
      // 证据段 ID 同样要校验存在性
      const badEvidence = evidence.filter((x) => !segIds.has(x));
      invalidEvidence.push(...badEvidence);
      evidence = evidence.filter((x) => segIds.has(x));
      // verdict 说 missing 却给了证据 -> 以证据为准，改成 partial（不自相矛盾地报"缺失但有出处"）
      validGates.push({
        gate: key,
        verdict: evidence.length > 0 && verdict === 'missing' ? 'partial' : verdict,
        evidence_seg_ids: evidence,
        reason: typeof g.reason === 'string' ? g.reason : '',
      });
    }
    record(3, 'tool', 'gate_match', s3, Date.now(), null, {
      gates: validGates.length,
      hit: validGates.filter((g) => g.verdict === 'hit').length,
      missing: validGates.filter((g) => g.verdict === 'missing').length,
      invalid_evidence_ids: invalidEvidence.length,
    }, null);

    if (validGates.length === 0) {
      return finish([], 'analyze_resume 未产出任何有效核对结果', [], jdAnalysis.hard_req);
    }

    /* ---------- Step 4：生成建议 ---------- */
    const s4 = Date.now();
    let raw: RawGeneration;
    try {
      const { data, usage } = await this.client.chatJson<RawGeneration>(
        generateMessages(resume, jd, validGates, strict),
      );
      raw = data;
      inputTokens += usage.input_tokens;
      outputTokens += usage.output_tokens;
      costCny += costOf(this.model, usage.input_tokens, usage.output_tokens, usage.cached_input_tokens);
      record(4, 'llm', 'generate', s4, Date.now(), {
        input: usage.input_tokens,
        output: usage.output_tokens,
      }, { raw_count: Array.isArray(data.suggestions) ? data.suggestions.length : 0, attempt: usage.attempts }, null);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      record(4, 'llm', 'generate', s4, Date.now(), null, {}, msg);
      return finish([], `generate 失败：${msg}`, [], jdAnalysis.hard_req);
    }

    /* ---------- 收敛成 Suggestion[] ---------- */
    const runKey = `${this.model.id}__${this.promptVersion}`;
    const suggestions: Suggestion[] = [];
    const invalidAnchors: string[] = [];

    const list = Array.isArray(raw.suggestions) ? raw.suggestions : [];
    list.forEach((s, i) => {
      const text = typeof s?.text === 'string' ? s.text.trim() : '';
      if (text.length === 0) return;

      const rawAnchor = typeof s?.anchor_seg_id === 'string' ? s.anchor_seg_id.trim() : null;
      let anchor: string | null = null;
      if (rawAnchor !== null && rawAnchor.length > 0 && rawAnchor.toLowerCase() !== 'null') {
        if (segIds.has(rawAnchor)) {
          anchor = rawAnchor;
        } else {
          // 编造的段 ID：置 null（不让假锚点灌水覆盖率），但记录下来
          invalidAnchors.push(rawAnchor);
        }
      }

      const kind = typeof s?.kind === 'string' && VALID_KINDS.has(s.kind) ? s.kind : 'improve';
      suggestions.push({
        id: `${runKey}-${c.id}-r${runIndex}-${i}`,
        case_id: c.id,
        run_id: runKey,
        run_index: runIndex,
        kind: kind as Suggestion['kind'],
        text,
        anchor_seg_id: anchor,
      });
    });

    if (suggestions.length === 0) {
      return finish([], 'generate 未产出任何有效建议', invalidAnchors, jdAnalysis.hard_req);
    }

    rootSpan.attrs = {
      ...(rootSpan.attrs ?? {}),
      suggestion_count: suggestions.length,
      anchor_rate: suggestions.filter((s) => s.anchor_seg_id !== null).length / suggestions.length,
      invalid_anchor_count: invalidAnchors.length,
    };
    return finish(suggestions, null, invalidAnchors, jdAnalysis.hard_req);
  }
}

/* ------------------------------------------------------------------ */

function resolveBaseUrl(model: ModelSpec): string {
  return PROVIDERS[model.provider].baseUrl;
}

function resolveKey(model: ModelSpec): string {
  const { apiKey, missing } = resolveApiKey(model);
  if (missing) {
    const p = PROVIDERS[model.provider];
    throw new Error(
      `缺少 ${p.label} 的 API Key。\n` +
        `  1. 去 ${p.signupUrl} 注册并创建 API Key\n` +
        `  2. 在项目根目录的 .env 里写 ${p.apiKeyEnv}=你的key\n` +
        `  3. 重新运行`,
    );
  }
  return apiKey;
}
