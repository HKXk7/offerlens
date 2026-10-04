/**
 * 最小可用的 OpenAI 兼容 chat 客户端 —— 零依赖，只用内置 fetch。
 *
 * 为什么不用官方 SDK：
 *   智谱 / 硅基流动 / DeepSeek / 火山 / Ollama 全都是 OpenAI 兼容协议，
 *   一个 fetch 就能全覆盖，省掉 N 个 SDK 的依赖和版本冲突。
 *   4 周版要的是"能跑起来且看得懂"，不是"生态完整"。
 *
 * 这里处理的四件事，都是真接模型时一定会踩的：
 *   1. 429 / 5xx 重试 —— 免费档限流很凶，不重试跑不完一批
 *   2. 超时 —— 不设超时，一个卡死的请求会让整批任务挂住
 *   3. JSON 抽取 —— 模型经常在 JSON 外面裹一层 ```json 或加一句解释
 *   4. token 记账 —— 成本指标的数据来源，不能用估算糊弄
 */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LlmCallOptions {
  /** 采样温度，默认 0.2（评测场景要的是稳定，不是创意） */
  temperature?: number;
  /** 单次请求超时（毫秒） */
  timeoutMs?: number;
  /** 最大重试次数（不含首次） */
  maxRetries?: number;
  /** 要求模型返回 JSON 对象（部分厂商支持） */
  jsonMode?: boolean;
  /** 输出上限 */
  maxTokens?: number;
  /**
   * 厂商特有的额外请求体字段，原样并入 body。
   *
   * DeepSeek 是唯一必须用到它的：`deepseek-flash` **默认开启思考模式**，
   * 思考 token 按输出价计费，跑评测会直接把预算烧光，而且回复正文可能被
   * 截断在 max_tokens 里。所以要显式传 `thinking: { type: 'disabled' }`。
   */
  extraBody?: Record<string, unknown>;
}

export interface LlmResult {
  text: string;
  input_tokens: number;
  output_tokens: number;
  /**
   * 命中上下文缓存的输入 token 数。
   * 计费单价只有未命中的 1/50 左右，不单独算会让成本报告严重虚高。
   */
  cached_input_tokens: number;
  latency_ms: number;
  /** 实际发了几次请求（含重试） */
  attempts: number;
  model: string;
  /**
   * 结束原因。`length` = 被 max_tokens 截断 —— JSON 解析失败时，
   * 分清"格式错"还是"被截断"是第一件要做的事，所以必须带出来。
   */
  finish_reason?: string;
  /** 中途失败时的最后一个错误 */
  error?: string;
}

export interface LlmClientOptions extends LlmCallOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
}

/** 会重试的 HTTP 状态码：限流 + 服务端错误。4xx 里的参数错误不重试（重试也不会好） */
const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 从模型回复里把 JSON 抠出来。
 *
 * 模型不会乖乖只回一个 JSON，常见三种情况：
 *   1. 纯 JSON —— 直接 parse
 *   2. ```json ... ``` 围栏 —— 剥掉围栏
 *   3. "好的，以下是结果：{...} 希望对你有帮助" —— 前后有自然语言
 * 第 3 种必须用「花括号配对（考虑字符串内的括号）」来定位，正则一定写错。
 */
export function extractJson<T = unknown>(raw: string): T {
  const text = raw.trim();

  const tryParse = (s: string): T | null => {
    try {
      return JSON.parse(s) as T;
    } catch {
      return null;
    }
  };

  // 1) 纯 JSON
  const direct = tryParse(text);
  if (direct !== null) return direct;

  // 2) 围栏
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) {
    const inner = tryParse(fence[1].trim());
    if (inner !== null) return inner;
  }

  // 3) 花括号配对扫描：从第一个 { 或 [ 开始，数深度，跳过字符串字面量
  const start = (() => {
    const a = text.indexOf('{');
    const b = text.indexOf('[');
    if (a === -1) return b;
    if (b === -1) return a;
    return Math.min(a, b);
  })();
  if (start >= 0) {
    const open = text[start];
    const close = open === '{' ? '}' : ']';
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === open) depth++;
      else if (ch === close) {
        depth--;
        if (depth === 0) {
          const candidate = tryParse(text.slice(start, i + 1));
          if (candidate !== null) return candidate;
          break;
        }
      }
    }
  }

  throw new Error(`模型回复里找不到合法 JSON。原始回复前 300 字：\n${raw.slice(0, 300)}`);
}

interface OpenAiChoice {
  message?: { content?: string | null };
  finish_reason?: string;
}

interface OpenAiResponse {
  choices?: OpenAiChoice[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    /** DeepSeek 把缓存命中与未命中的输入 token 分开报，单价差约 50 倍 */
    prompt_cache_hit_tokens?: number;
    prompt_cache_miss_tokens?: number;
  };
  error?: { message?: string; type?: string; code?: string };
}

/** 兜底粗估：厂商没回 usage 时，按"1 token ≈ 1.7 个字符"估算中文与代码混合文本 */
function estimateTokens(s: string): number {
  return Math.max(1, Math.round(s.length / 1.7));
}

export class LlmClient {
  constructor(private readonly opts: LlmClientOptions) {}

  get model(): string {
    return this.opts.model;
  }

  async chat(messages: readonly ChatMessage[], overrides: LlmCallOptions = {}): Promise<LlmResult> {
    const opts = { ...this.opts, ...overrides };
    const temperature = opts.temperature ?? 0.2;
    const timeoutMs = opts.timeoutMs ?? 90_000;
    const maxRetries = opts.maxRetries ?? 3;

    const url = `${this.opts.baseUrl.replace(/\/+$/, '')}/chat/completions`;

    /**
     * `response_format` 是**可降级**的，不能当成硬依赖。
     *
     * 实测踩到：硅基流动上的 `zai-org/GLM-4.5-Air` 对 `response_format`
     * 直接返回 400 `code 20024: Json mode is not supported for this model`，
     * 整条运行当场判死、成本记 0 —— 看起来像"模型不行"，其实是接口能力差异。
     *
     * 处理方式：遇到这类 400 就**去掉该字段重试**。prompt 里本来就写了
     * "只输出 JSON"，少一个格式约束不等于跑不了，只是解析要更宽容
     *（extractJson 已经能处理围栏、前后缀自然语言）。
     */
    const JSON_MODE_REJECTED = /json[_ ]?mode|response_format|json_object/i;
    let jsonMode = opts.jsonMode === true;

    const buildBody = (): Record<string, unknown> => {
      const body: Record<string, unknown> = { model: this.opts.model, messages, temperature };
      if (opts.maxTokens !== undefined) body.max_tokens = opts.maxTokens;
      if (jsonMode) body.response_format = { type: 'json_object' };
      // 厂商特有参数（关思考开关等）后置覆盖，保证优先级最高
      if (opts.extraBody) Object.assign(body, opts.extraBody);
      return body;
    };

    let lastError = '';
    const startedAll = Date.now();

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${this.opts.apiKey}`,
          },
          body: JSON.stringify(buildBody()),
          signal: controller.signal,
        });

        if (!res.ok) {
          const text = await res.text().catch(() => '');
          lastError = `HTTP ${res.status}: ${text.slice(0, 300)}`;
          // 该模型不支持 JSON 模式 —— 降级去字段重试，不要把整条运行判死
          if (res.status === 400 && jsonMode && JSON_MODE_REJECTED.test(text)) {
            jsonMode = false;
            await sleep(200);
            continue;
          }
          if (RETRYABLE_STATUS.has(res.status) && attempt < maxRetries) {
            // 指数退避 + 抖动：免费档限流下，固定间隔重试容易撞在一起继续 429
            await sleep(Math.min(8000, 500 * 2 ** attempt) + Math.random() * 400);
            continue;
          }
          throw new Error(lastError);
        }

        const json = (await res.json()) as OpenAiResponse;
        if (json.error) {
          lastError = `接口返回错误：${json.error.message ?? JSON.stringify(json.error)}`;
          // 限流类错误码也重试
          if (/rate|limit|busy|overload/i.test(lastError) && attempt < maxRetries) {
            await sleep(Math.min(8000, 500 * 2 ** attempt) + Math.random() * 400);
            continue;
          }
          throw new Error(lastError);
        }

        const content = json.choices?.[0]?.message?.content ?? '';
        if (content.trim().length === 0) {
          lastError = '模型返回了空内容';
          if (attempt < maxRetries) {
            await sleep(500 * 2 ** attempt);
            continue;
          }
          throw new Error(lastError);
        }

        const promptMessages = messages.map((m) => m.content).join('\n');
        return {
          text: content,
          input_tokens: json.usage?.prompt_tokens ?? estimateTokens(promptMessages),
          output_tokens: json.usage?.completion_tokens ?? estimateTokens(content),
          cached_input_tokens: json.usage?.prompt_cache_hit_tokens ?? 0,
          latency_ms: Date.now() - startedAll,
          attempts: attempt + 1,
          model: this.opts.model,
          finish_reason: json.choices?.[0]?.finish_reason,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        lastError = /abort/i.test(msg) ? `请求超时（${timeoutMs}ms）` : msg;
        if (attempt < maxRetries) {
          await sleep(Math.min(8000, 500 * 2 ** attempt) + Math.random() * 400);
          continue;
        }
      } finally {
        clearTimeout(timer);
      }
    }

    return {
      text: '',
      input_tokens: 0,
      output_tokens: 0,
      cached_input_tokens: 0,
      latency_ms: Date.now() - startedAll,
      attempts: maxRetries + 1,
      model: this.opts.model,
      error: lastError,
    };
  }

  /** 要 JSON 的调用：失败时抛错（评测场景不能默默拿空结果继续） */
  async chatJson<T>(messages: readonly ChatMessage[], overrides: LlmCallOptions = {}): Promise<{
    data: T;
    usage: LlmResult;
  }> {
    const usage = await this.chat(messages, { jsonMode: true, ...overrides });
    if (usage.error) throw new Error(usage.error);
    try {
      return { data: extractJson<T>(usage.text), usage };
    } catch (err) {
      // 把 finish_reason 与输出长度一起抛出来：被截断（length）和格式错
      // 是两种完全不同的故障，只报"找不到 JSON"会把排查方向带偏。
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `${msg}\n　（finish_reason=${usage.finish_reason ?? '未知'}，输出 ${usage.output_tokens} token，` +
          `输入 ${usage.input_tokens} token）`,
      );
    }
  }
}
