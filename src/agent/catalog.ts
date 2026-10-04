/**
 * 模型目录 / Provider 配置 / 评测档位（profile）。
 *
 * 三条硬约束（都是策划书里定死的，不是随便选的）：
 *   1. **judge 必须与被测模型不同族**。同族 judge 有系统性偏袒，
 *      比出来的"谁更好"是假的。所以生成用智谱，裁判用硅基流动上的 Qwen。
 *   2. **成本必须记账**。每个模型带价格，跑完能算出真实花的钱。
 *   3. **凭证只从环境变量读**，不写进代码、不写进配置文件的明文。
 *
 * 2026-10 的免费额度现状（注册即得，不用花钱）：
 *   · 智谱 GLM-4-Flash / 4.5-Flash / 4.7-Flash —— 永久免费、不限 token、约 30 并发
 *   · 硅基流动 —— 注册送额度 + 一批永久免费小模型（需实名）
 *   · Ollama —— 本地跑，彻底零成本，作为断网兜底
 *
 * 也就是说，**跑完 24 组 × 3 档位 × 3 次重复 = 216 次运行，成本是 ¥0**。
 */

export type ProviderId = 'zhipu' | 'siliconflow' | 'deepseek' | 'ollama';

export interface ProviderConfig {
  id: ProviderId;
  label: string;
  /** OpenAI 兼容 base url。注意智谱的结尾斜杠是必须的 */
  baseUrl: string;
  /** 读哪个环境变量拿 key；ollama 不需要 */
  apiKeyEnv: string | null;
  /** 没有 key 时用的固定值（ollama 忽略鉴权） */
  fallbackApiKey?: string;
  /** 申请地址，报错时打出来给用户指路 */
  signupUrl: string;
  /** 免费档的并发建议（限流撞多了就调小） */
  suggestedConcurrency: number;
}

export const PROVIDERS: Record<ProviderId, ProviderConfig> = {
  zhipu: {
    id: 'zhipu',
    label: '智谱 GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4/',
    apiKeyEnv: 'ZHIPU_API_KEY',
    signupUrl: 'https://open.bigmodel.cn/',
    suggestedConcurrency: 6,
  },
  siliconflow: {
    id: 'siliconflow',
    label: '硅基流动',
    baseUrl: 'https://api.siliconflow.cn/v1',
    apiKeyEnv: 'SILICONFLOW_API_KEY',
    signupUrl: 'https://cloud.siliconflow.cn/',
    suggestedConcurrency: 4,
  },
  deepseek: {
    id: 'deepseek',
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    signupUrl: 'https://platform.deepseek.com/',
    suggestedConcurrency: 4,
  },
  ollama: {
    id: 'ollama',
    label: 'Ollama（本地）',
    baseUrl: 'http://localhost:11434/v1',
    apiKeyEnv: null,
    fallbackApiKey: 'ollama',
    signupUrl: 'https://ollama.com/download',
    suggestedConcurrency: 1,
  },
};

export interface ModelSpec {
  /** 传给 API 的 model 名 */
  id: string;
  label: string;
  provider: ProviderId;
  /** 元 / 百万 input token（缓存未命中）。0 表示免费档 */
  priceInPerM: number;
  /** 元 / 百万 output token。0 表示免费档 */
  priceOutPerM: number;
  /**
   * 元 / 百万 input token（**缓存命中**）。
   * 不填则等于 priceInPerM。DeepSeek / 智谱都有自动上下文缓存，
   * 本项目的 system prompt 与简历正文在不同 case 间高度重复，命中率不低，
   * 不区分会让成本报告虚高一个量级。
   */
  priceCachedInPerM?: number;
  /** 价格是否为估算值——报告里会标出来，避免把估的价当官方价 */
  priceEstimated?: boolean;
  /**
   * 该模型的**显式输出上限**。
   *
   * 为什么不能省：不传 max_tokens 就等于把上限交给服务端默认值，
   * 而各家默认值不一样 —— 硅基流动是 4096。实测 `Ling-flash-2.0`
   * 每次调用都在 4096 处被截断（finish_reason=length），JSON 永远不完整，
   * 三次全挂。看起来像"模型不行"，其实是上限没给够。
   *
   * 同时它本身也是**成本护栏**：一个跑飞了的模型可以在默认上限很高
   *（有的厂商 32k）的主机上把预算一次烧掉。评测平台必须自己拿住这个阀门。
   *
   * 口径：同一批矩阵里的模型**统一给同一个值**，不给单个模型开小灶 ——
   * 上限是资源旋钮，不是能力旋钮，差异化设置会污染横向对比。
   */
  maxTokens?: number;
  /** 厂商特有请求体字段，见 llm.ts 的 extraBody */
  extraBody?: Record<string, unknown>;
}

/**
 * 跨厂商矩阵统一的输出上限。
 *
 * 硅基流动的服务端默认是 4096，`Ling-flash-2.0` 每次都在这里被截断。
 * 所以**显式指定**，同批矩阵所有模型用同一个值：
 *   · 上限是资源旋钮，不是能力旋钮，统一才可比
 *   · 也是成本护栏 —— 不设就等于把"一次调用最多花多少钱"交给主机默认值
 */
export const SF_MAX_TOKENS = 8192;

export const MODELS: Record<string, ModelSpec> = {
  /** ---------- 智谱：永久免费的生成侧主力 ---------- */
  'glm-4.7-flash': {
    id: 'glm-4.7-flash',
    label: 'GLM-4.7-Flash',
    provider: 'zhipu',
    priceInPerM: 0,
    priceOutPerM: 0,
  },
  'glm-4.5-flash': {
    id: 'glm-4.5-flash',
    label: 'GLM-4.5-Flash',
    provider: 'zhipu',
    priceInPerM: 0,
    priceOutPerM: 0,
  },
  'glm-4-flash': {
    id: 'glm-4-flash',
    label: 'GLM-4-Flash',
    provider: 'zhipu',
    priceInPerM: 0,
    priceOutPerM: 0,
  },
  /** 付费档：留作"免费档 vs 付费档差多少"的对照，默认不启用 */
  'glm-4-plus': {
    id: 'glm-4-plus',
    label: 'GLM-4-Plus（付费）',
    provider: 'zhipu',
    priceInPerM: 50,
    priceOutPerM: 50,
    priceEstimated: true,
  },

  /** ---------- 硅基流动中国站：跨厂商对比矩阵的生成侧 ---------- */
  /**
   * 价格口径（2026-10 硅基流动中国站官网定价页，元/百万 token，非估算）：
   *
   *   deepseek-ai/DeepSeek-V4-Flash  分时段：2–8 点 ¥1.5/¥4.5（缓存 ¥0.15）
   *                                          0–2/8–24 点 ¥3/¥9（缓存 ¥0.30）
   *   Qwen/Qwen3.5-122B-A10B         ¥0.8/¥6.4（[0,128k)）
   *   Qwen/Qwen3.5-27B               ¥0.6/¥4.8
   *   zai-org/GLM-4.5-Air            ¥1.0/¥6.0
   *   inclusionAI/Ling-flash-2.0     ¥1.0/¥4.0
   *   tencent/Hunyuan-A13B-Instruct  分时段：9–18 点 ¥1.0/¥4.0，其余 ¥0.8/¥3.2
   *
   * ⚠️ 凡是分时段计价的，一律按**贵的那一档**填。宁可把预算估高提前停，
   * 也不能估低跑超 —— 这是这个项目一贯的口径（DeepSeek 官方那档同理）。
   *
   * ⚠️ 关思考参数**必须逐个模型实测确认**，不能照抄：
   *   · Qwen3.5 全系、Ling —— `enable_thinking: false`
   *   · GLM-4.5-Air、DeepSeek-V4-Flash(硅基流动) —— `thinking: { type: 'disabled' }`
   *   实测依据（data/tmp/probe*.mjs）：不关思考时，
   *     Qwen3.5-122B 单次「只回两个字」输出 4117 token（其中 reasoning 14325 字），
   *     Qwen3.5-9B 输出 3454 token，GLM-4.5-Air 输出 318 token。
   *   本项目每 run 输出约 6000 token，思考 token 按输出价计费，
   *   不关思考 = 成本直接放大到不可接受。
   *
   * ❌ stepfun-ai/Step-3.5-Flash 已实测排除：`enable_thinking:false` 对它无效，
   *    默认常开思考（单次输出 272 token，reasoning 522 字），不可控，不入选。
   */
  'deepseek-ai/DeepSeek-V4-Flash': {
    id: 'deepseek-ai/DeepSeek-V4-Flash',
    label: 'DeepSeek-V4-Flash（硅基流动，非思考）',
    provider: 'siliconflow',
    priceInPerM: 3.0,
    priceCachedInPerM: 0.3,
    priceOutPerM: 9.0,
    maxTokens: SF_MAX_TOKENS,
    extraBody: { thinking: { type: 'disabled' } },
  },
  'Qwen/Qwen3.5-122B-A10B': {
    id: 'Qwen/Qwen3.5-122B-A10B',
    label: 'Qwen3.5-122B-A10B',
    provider: 'siliconflow',
    priceInPerM: 0.8,
    priceOutPerM: 6.4,
    maxTokens: SF_MAX_TOKENS,
    extraBody: { enable_thinking: false },
  },
  'Qwen/Qwen3.5-27B': {
    id: 'Qwen/Qwen3.5-27B',
    label: 'Qwen3.5-27B',
    provider: 'siliconflow',
    priceInPerM: 0.6,
    priceOutPerM: 4.8,
    maxTokens: SF_MAX_TOKENS,
    extraBody: { enable_thinking: false },
  },
  'zai-org/GLM-4.5-Air': {
    id: 'zai-org/GLM-4.5-Air',
    label: 'GLM-4.5-Air',
    provider: 'siliconflow',
    priceInPerM: 1.0,
    priceOutPerM: 6.0,
    maxTokens: SF_MAX_TOKENS,
    extraBody: { thinking: { type: 'disabled' } },
  },
  'inclusionAI/Ling-flash-2.0': {
    id: 'inclusionAI/Ling-flash-2.0',
    label: 'Ling-flash-2.0（蚂蚁）',
    provider: 'siliconflow',
    priceInPerM: 1.0,
    priceOutPerM: 4.0,
    maxTokens: SF_MAX_TOKENS,
    extraBody: { enable_thinking: false },
  },
  /** 跨族裁判：腾讯混元，与上面任何一个生成侧厂商都不同族 */
  'tencent/Hunyuan-A13B-Instruct': {
    id: 'tencent/Hunyuan-A13B-Instruct',
    label: 'Hunyuan-A13B-Instruct（腾讯）',
    provider: 'siliconflow',
    priceInPerM: 1.0,
    priceOutPerM: 4.0,
    maxTokens: SF_MAX_TOKENS,
    extraBody: { enable_thinking: false },
  },

  /** ---------- 硅基流动：跨族 judge 的来源 ---------- */
  'Qwen/Qwen3-8B': {
    id: 'Qwen/Qwen3-8B',
    label: 'Qwen3-8B（硅基流动）',
    provider: 'siliconflow',
    priceInPerM: 0,
    priceOutPerM: 0,
    extraBody: { enable_thinking: false },
  },
  'THUDM/GLM-Z1-9B-0414': {
    id: 'THUDM/GLM-Z1-9B-0414',
    label: 'GLM-Z1-9B（硅基流动免费）',
    provider: 'siliconflow',
    priceInPerM: 0,
    priceOutPerM: 0,
  },

  /** ---------- DeepSeek：便宜、直接返回 JSON，作为实测主力 ---------- */
  /**
   * 价格口径（2026-10 官方 https://api-docs.deepseek.com/quick_start/pricing）：
   *   USD → CNY 按 7.2 折算；采用**峰时价**，即刻意高估一倍（谷时是峰时的一半）。
   *   宁可把预算估高、提前停，也不能估低跑超。
   *
   *   deepseek-flash    峰时 $0.30 / $0.006 / $1.20  每百万（入-未命中 / 入-命中 / 出）
   *   deepseek-v4-pro   峰时 $1.32 / $0.044 / $3.96
   *
   * 两个模型都**必须显式关掉思考模式**：DeepSeek 新版默认 thinking=enabled，
   * 思考 token 按输出价计费，而且回复正文会被 max_tokens 截断，
   * JSON 解析直接失败 —— 这是实测踩到的，不是推测。
   */
  'deepseek-flash': {
    id: 'deepseek-flash',
    label: 'DeepSeek-V4.1-Flash',
    provider: 'deepseek',
    priceInPerM: 2.16,
    priceCachedInPerM: 0.043,
    priceOutPerM: 8.64,
    priceEstimated: true,
    extraBody: { thinking: { type: 'disabled' } },
  },
  'deepseek-v4-pro': {
    id: 'deepseek-v4-pro',
    label: 'DeepSeek-V4-Pro',
    provider: 'deepseek',
    priceInPerM: 9.5,
    priceCachedInPerM: 0.317,
    priceOutPerM: 28.51,
    priceEstimated: true,
    extraBody: { thinking: { type: 'disabled' } },
  },

  /** ---------- Ollama：断网兜底 ---------- */
  'qwen2.5:7b': {
    id: 'qwen2.5:7b',
    label: 'Qwen2.5-7B（本地）',
    provider: 'ollama',
    priceInPerM: 0,
    priceOutPerM: 0,
  },
};

/** 生成侧 prompt 版本。改 prompt 就是在改这个文件的指令文本 */
export type PromptVersion = 'p1-baseline' | 'p2-strict';

export interface EvalProfile {
  /** 落库主键前缀，同时是 reports 里的配置名 */
  run_id: string;
  model: ModelSpec;
  prompt_version: PromptVersion;
}

/**
 * DeepSeek 档位的默认评测矩阵 —— 只有一个 key 时用这套。
 *
 * 单变量设计：
 *   flash__p1-baseline  基线
 *   flash__p2-strict    ← 只改 prompt，模型不变 ⇒ 回答"改 prompt 有用吗"
 *   pro__p1-baseline    ← 只改模型，prompt 不变 ⇒ 回答"换更贵的模型有用吗"
 *
 * 两个变量各自只动一次，才不会把"模型变强"和"prompt 变好"混成一个数字。
 */
export function deepseekProfiles(): EvalProfile[] {
  return [
    { run_id: 'flash__p1-baseline', model: MODELS['deepseek-flash'], prompt_version: 'p1-baseline' },
    { run_id: 'flash__p2-strict', model: MODELS['deepseek-flash'], prompt_version: 'p2-strict' },
    { run_id: 'pro__p1-baseline', model: MODELS['deepseek-v4-pro'], prompt_version: 'p1-baseline' },
  ];
}

/**
 * 硅基流动中国站的**跨厂商矩阵** —— 手上有硅基流动 key 时用这套。
 *
 * 与 DeepSeek 矩阵的区别：那里问的是「prompt 改一下有用吗」，
 * 这里问的是「同一件事，换哪个厂商/哪个尺寸的模型做更好」。
 * 所以**固定 prompt 为 p2-strict**（已证明 p2 显著优于 p1），
 * 只动模型这一个变量 —— 否则分不清差异来自模型还是来自 prompt。
 *
 * 档位设计（每个厂商一个代表 + Qwen 内部做一个尺寸轴）：
 *   sf-dsv4flash__p2-strict   DeepSeek 系  旗舰小尺寸（非思考）  ¥3.0/¥9.0
 *   sf-qwen35-122b__p2-strict 阿里 Qwen 系 122B-A10B 大 MoE      ¥0.8/¥6.4
 *   sf-qwen35-27b__p2-strict  阿里 Qwen 系 27B（尺寸对照）        ¥0.6/¥4.8
 *   sf-glm45-air__p2-strict   智谱 GLM 系 Air 档                 ¥1.0/¥6.0
 *   sf-ling-flash2__p2-strict 蚂蚁 Ling 系                       ¥1.0/¥4.0
 *
 * 第一个是基线，对比矩阵全部相对它算（见 baselineRunId）。
 * Qwen 放两档是刻意的：它同时回答「厂商之间差多少」和「同一厂商里
 * 便宜的 27B 够不够用」——后者才是真正能省钱的那个问题。
 */
export function siliconflowProfiles(): EvalProfile[] {
  return [
    {
      run_id: 'sf-dsv4flash__p2-strict',
      model: MODELS['deepseek-ai/DeepSeek-V4-Flash'],
      prompt_version: 'p2-strict',
    },
    {
      run_id: 'sf-qwen35-122b__p2-strict',
      model: MODELS['Qwen/Qwen3.5-122B-A10B'],
      prompt_version: 'p2-strict',
    },
    {
      run_id: 'sf-qwen35-27b__p2-strict',
      model: MODELS['Qwen/Qwen3.5-27B'],
      prompt_version: 'p2-strict',
    },
    {
      run_id: 'sf-glm45-air__p2-strict',
      model: MODELS['zai-org/GLM-4.5-Air'],
      prompt_version: 'p2-strict',
    },
  ];
}

/**
 * ⚠️ 实测被排除的候选，留档避免下次又踩（这些不是"没试"，是试过不行）：
 *
 *   inclusionAI/Ling-flash-2.0     每次调用都在 4096 被截断（finish_reason=length），
 *                                  三次全挂；单次真实调用 ~80 秒，跑 288 次要一个多小时。
 *                                  结构性不可用 + 太慢，双输。
 *   stepfun-ai/Step-3.5-Flash      `enable_thinking:false` 关不掉思考，成本不可控。
 *   ByteDance-Seed/Seed-OSS-36B    返回空内容（token 全花在 reasoning 上，正文为空）。
 *   Qwen/Qwen3.5-35B-A3B           单步 90 秒超时，一趟 366 秒，跑不动整批。
 *   tencent/Hy4-preview            能跑通且只要 23 秒，但它是**腾讯系**，
 *                                  而本矩阵的裁判正是腾讯混元 —— 收进来就没有跨族裁判了。
 *
 * 也就是说，"哪些国产模型能接进这个流水线"本身就是一次筛选：
 * 光看榜单看不出"输出被截断""默认开思考关不掉""正文为空"这类工程可用性问题。
 */

/**
 * 默认评测矩阵。
 *
 * 选哪套由**已有的 key** 决定，不需要改代码：
 *   · 有硅基流动 key → 跨厂商矩阵（能一次比多个厂商，信息量最大）
 *   · 只有 DeepSeek key → DeepSeek 单变量矩阵
 *   · 都没有 → 智谱免费档矩阵（离线兜底）
 *
 * ⚠️ 两个平台的数字**不能混进同一张对比表**：硅基流动是第三方转发，
 * 量化精度、推理后端、甚至温度默认值都可能与原厂不同。
 * 同一批结论必须在同一个平台上跑完。
 */
export function defaultProfiles(): EvalProfile[] {
  const has = (env: string) => (process.env[env] ?? '').trim().length > 0;
  if (has('SILICONFLOW_API_KEY')) return siliconflowProfiles();
  if (has('DEEPSEEK_API_KEY')) return deepseekProfiles();
  return [
    { run_id: 'glm45__p1-baseline', model: MODELS['glm-4.5-flash'], prompt_version: 'p1-baseline' },
    { run_id: 'glm47__p1-baseline', model: MODELS['glm-4.7-flash'], prompt_version: 'p1-baseline' },
    { run_id: 'glm45__p2-strict', model: MODELS['glm-4.5-flash'], prompt_version: 'p2-strict' },
  ];
}

/** 基线是矩阵里第一个 —— 对比矩阵全部相对它算。改这个要写进报告，否则结论不可比 */
export function baselineRunId(profiles: readonly EvalProfile[] = defaultProfiles()): string {
  const first = profiles[0];
  if (!first) throw new Error('评测档位为空');
  return first.run_id;
}

/**
 * 模型所属「族」（厂商）。
 *
 * 为什么需要它：judge 必须与被测模型**不同族**。之前这个判断是写死的
 * 分支（"有硅基流动 key 就用 Qwen3-8B 当裁判"）——直到矩阵里真的加了
 * Qwen3.5，这条硬编码就变成了"让 Qwen 给 Qwen 打分"，
 * 而 crossFamily 还照报 true。结论有效性直接被悄悄破坏，且看不出来。
 *
 * 所以改成：先从矩阵推出"哪些族正在被测"，再挑一个不在里面的当裁判。
 */
const FAMILY_RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [/^deepseek-ai\//, 'deepseek'],
  [/^deepseek-/, 'deepseek'],
  [/^Qwen\//, 'qwen'],
  [/^qwen/i, 'qwen'],
  [/^zai-org\//, 'zhipu'],
  [/^THUDM\//, 'zhipu'],
  [/^glm-/i, 'zhipu'],
  [/^inclusionAI\//, 'inclusionai'],
  [/^tencent\//, 'tencent'],
  [/^moonshotai\//, 'moonshot'],
  [/^meituan-longcat\//, 'meituan'],
  [/^stepfun-ai\//, 'stepfun'],
  [/^ByteDance-Seed\//, 'bytedance'],
];

export function familyOf(model: ModelSpec): string {
  for (const [re, family] of FAMILY_RULES) if (re.test(model.id)) return family;
  return model.provider;
}

/**
 * 裁判模型：优先选**与生成侧不同族**的。
 *
 * 选择顺序：
 *   1. 有硅基流动 key → 腾讯 Hunyuan-A13B-Instruct
 *      （矩阵里的 DeepSeek / Qwen / 智谱 / 蚂蚁 四族它都不是，最干净）
 *   2. 有 DeepSeek key → DeepSeek-V4-Pro（只有当矩阵里没有 DeepSeek 时才是跨族）
 *   3. 兜底 → GLM-4.7-Flash
 *
 * crossFamily 是**算出来的**，不是写死的：只要裁判族与被测族有交集就报 false，
 * 报告里会跟着打警告。宁可如实承认"同族"，也不要一个看起来很正式的错误结论。
 */
export function defaultJudge(): { model: ModelSpec; crossFamily: boolean } {
  const has = (env: string) => (process.env[env] ?? '').trim().length > 0;
  const underTest = new Set(defaultProfiles().map((p) => familyOf(p.model)));
  const pick = (id: string) => {
    const model = MODELS[id];
    if (!model) throw new Error(`裁判模型 ${id} 不在 MODELS 里`);
    return { model, crossFamily: !underTest.has(familyOf(model)) };
  };

  if (has('SILICONFLOW_API_KEY')) return pick('tencent/Hunyuan-A13B-Instruct');
  if (has('DEEPSEEK_API_KEY')) return pick('deepseek-v4-pro');
  return pick('glm-4.7-flash');
}

export function resolveApiKey(model: ModelSpec): { apiKey: string; missing: boolean } {
  const provider = PROVIDERS[model.provider];
  if (provider.apiKeyEnv === null) {
    return { apiKey: provider.fallbackApiKey ?? '', missing: false };
  }
  const key = (process.env[provider.apiKeyEnv] ?? '').trim();
  if (key.length > 0) return { apiKey: key, missing: false };
  return { apiKey: '', missing: true };
}

/**
 * 计算一次调用的人民币成本。
 *
 * cachedInputTokens 必须单独传入并单独计价：缓存命中的输入单价约为未命中的 1/50，
 * 若一律按未命中价算，本项目的成本会被高估一个量级（system prompt 与简历正文
 * 在 case 之间高度重复，实际命中率很高）。
 */
export function costOf(
  model: ModelSpec,
  inputTokens: number,
  outputTokens: number,
  cachedInputTokens = 0,
): number {
  const cached = Math.min(Math.max(0, cachedInputTokens), Math.max(0, inputTokens));
  const missed = Math.max(0, inputTokens - cached);
  const cachedPrice = model.priceCachedInPerM ?? model.priceInPerM;
  return (
    (missed / 1e6) * model.priceInPerM +
    (cached / 1e6) * cachedPrice +
    (outputTokens / 1e6) * model.priceOutPerM
  );
}

export function formatPrice(model: ModelSpec): string {
  if (model.priceInPerM === 0 && model.priceOutPerM === 0) return '免费';
  const mark = model.priceEstimated ? '≈' : '';
  return `${mark}¥${model.priceInPerM}/¥${model.priceOutPerM} 每百万 token（入/出）`;
}
