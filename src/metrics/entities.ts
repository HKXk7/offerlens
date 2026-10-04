import type { Jd, Resume } from '../schema/case.js';

/**
 * 实体抽取 —— 「无源实体率」的第一步，也是整个项目最容易被追问的地方。
 *
 * 面试官会问："你凭什么说这个数字是编的？"
 * 所以这里必须回答三件事：抽什么、怎么归一、什么时候会误判。
 *
 * 三路抽取：
 *   1. 数字/百分比/倍数 —— 正则。简历里的数字是最典型的幻觉来源（"提升 40%"）。
 *   2. 技术名词 —— 白名单词典（基础词表 + 从当前 JD/简历语料里自动补的词）。
 *   3. 公司名 / 项目名 —— 白名单词典。
 *
 * 归一化（不做归一化必然误报）：
 *   - 转小写、压缩空白、去掉首尾标点
 *   - 去掉版本号：`React 18` → `react`
 *   - 别名映射：`字节` / `字节跳动` → `字节跳动`
 *   - 数字带单位归一：`1.5万` → `15000`，`40%` → `40`
 *
 * 已知误报来源（必须能背出来，这是可信度所在）：
 *   a) 建议里**合法引入的新概念**（"建议补充 Redis 经验"）—— 用句式豁免规则处理
 *   b) 简历原文用同义表述（"做过" vs "负责"）—— 无解，靠人工抽检兜
 *   c) 词典外的技术名 —— 无解，且会同时造成漏报（真的编造但不在词典里）
 *   d) 跨段引用被误判 —— 本项目按"整份简历"判定出处，不做段内限定，规避此问题
 */

export type EntityKind = 'number' | 'tech' | 'org' | 'project';

export interface Entity {
  /** 原文里出现的写法 */
  raw: string;
  /** 归一化后的写法，用于比对 */
  normalized: string;
  kind: EntityKind;
  start: number;
  end: number;
  /** 是否命中"建议补充"类句式豁免 */
  exempted: boolean;
  /** 命中的豁免依据，便于人工复核 */
  exemptReason?: string;
}

export interface EntityDict {
  tech: string[];
  org: string[];
  project: string[];
  alias: Record<string, string>;
}

/* ------------------------------------------------------------------ */
/* 基础词表                                                            */
/* ------------------------------------------------------------------ */

export const BASE_TECH: readonly string[] = [
  'React', 'Vue', 'Vue 3', 'Angular', 'Svelte', 'Next.js', 'Nuxt', 'Taro', 'uni-app',
  'TypeScript', 'JavaScript', 'ES6', 'HTML', 'HTML5', 'CSS', 'CSS3', 'Sass', 'Less', 'Tailwind',
  'Node.js', 'Express', 'NestJS', 'Koa', 'BFF', 'SSR', 'CSR',
  'Vite', 'Webpack', 'Rollup', 'Babel', 'ESLint', 'pnpm', 'npm',
  'ECharts', 'AntV', 'G2', 'D3', 'Chart.js', 'Three.js', 'WebGL', 'Canvas', 'SVG',
  'Web Worker', 'WebSocket', 'SSE', 'HTTP', 'HTTPS', 'GraphQL', 'REST',
  'SQL', 'MySQL', 'PostgreSQL', 'MongoDB', 'Redis', 'SQLite', 'Prisma',
  'Docker', 'Kubernetes', 'K8s', 'Nginx', 'Linux', 'Git',
  'Python', 'Java', 'Go', 'Golang', 'Rust', 'C++',
  'Ant Design', 'Element Plus', 'TanStack', 'Zustand', 'Redux', 'Pinia', 'MobX',
  'Playwright', 'Cypress', 'Jest', 'Vitest', 'Puppeteer', 'Figma', 'Postman',
  '虚拟滚动', '懒加载', '首屏', '性能优化', '工程化', '组件库', '设计系统',
  'CRDT', '协同编辑', '低代码', '表单引擎', '埋点', '可视化',
];

export const BASE_ORG: readonly string[] = [
  '字节跳动', '腾讯', '阿里巴巴', '百度', '美团', '京东', '小米', '华为', '网易', '滴滴',
  '快手', '拼多多', '新浪', '搜狐', '携程', 'B站', '哔哩哔哩',
  '智谱', '月之暗面', 'MiniMax', '阶跃星辰', '面壁智能', '百川', '商汤', '旷视',
  '科大讯飞', '大疆', '中科院', '微软', '谷歌', '亚马逊', 'Meta',
  'OpenAI', 'Anthropic', 'LangChain', 'Langfuse', 'Braintrust', 'Weights & Biases',
];

/** 别名 → 规范名。只放"确定等价"的，宁可漏也不要错。 */
export const DEFAULT_ALIAS: Record<string, string> = {
  '字节': '字节跳动',
  '阿里': '阿里巴巴',
  '腾讯科技': '腾讯',
  '百度在线': '百度',
  '华为技术': '华为',
  'golang': 'go',
  'js': 'javascript',
  'ts': 'typescript',
  'threejs': 'three.js',
  'echart': 'echarts',
  'k8s': 'kubernetes',
  'web worker api': 'web worker',
};

/* ------------------------------------------------------------------ */
/* 归一化                                                              */
/* ------------------------------------------------------------------ */

const CN_UNIT: Record<string, number> = { 万: 1e4, 千: 1e3, 百: 1e2, k: 1e3, w: 1e4 };

export function normalizeToken(raw: string): string {
  let s = raw.trim().toLowerCase();
  s = s.replace(/^[\s"'“”‘’()（）【】\[\]，,。.、:：;；]+/, '');
  s = s.replace(/[\s"'“”‘’()（）【】\[\]，,。.、:：;；]+$/, '');
  s = s.replace(/\s+/g, ' ');
  // 去版本号：react 18 → react；es6 保留（ES6 是独立名词，不是版本后缀）
  if (!/^es\s*\d+$/.test(s)) {
    s = s.replace(/\s*v?\d+(\.\d+)*$/, '');
  }
  return DEFAULT_ALIAS[s] ?? s;
}

/** 数字归一：把 40%、1.5 万、3k 统一成可比的数值字符串 */
export function normalizeNumberLiteral(raw: string): string | null {
  const m = raw.match(/(\d+(?:\.\d+)?)\s*([万千万kKwW百]?)/);
  if (!m) return null;
  let value = Number.parseFloat(m[1]);
  if (!Number.isFinite(value)) return null;
  const unit = m[2] ? m[2].toLowerCase() : '';
  if (unit && CN_UNIT[unit] !== undefined) value *= CN_UNIT[unit];
  return String(Number(value.toFixed(4)));
}

/* ------------------------------------------------------------------ */
/* 词典构建                                                            */
/* ------------------------------------------------------------------ */

/**
 * 门槛描述词不是实体。
 *
 * 这是实际跑 demo 时踩到的坑：把 jd.hard_req 整个塞进词典后，
 * "本科及以上"「计算机相关专业」「5 年以上前端经验」也被当成技术名词抽出来，
 * 于是建议里每提一次门槛，就被判一次"编造"，无源实体率虚高到 0.65，整个指标废掉。
 *
 * 所以：要求类描述一律不进词典（它们该由覆盖率指标处理，而不是实体指标）。
 */
const REQUIREMENT_PHRASE_RE = /(及以上|以上|学历|专业|经验|实习|每周|到岗|优先|具备|须|要求)/;

export function isEntityLikeTerm(term: string): boolean {
  return !REQUIREMENT_PHRASE_RE.test(term);
}

export function buildDict(
  resume: Resume,
  jd: Jd,
  extra: Partial<EntityDict> = {},
): EntityDict {
  const uniq = (xs: string[]) => [...new Set(xs.filter((x) => x && x.trim().length > 0))];
  const gates = [...jd.hard_req, ...jd.soft_req].filter(isEntityLikeTerm);
  return {
    tech: uniq([...BASE_TECH, ...extra.tech ?? [], ...gates, ...resume.skills.filter(isEntityLikeTerm)]),
    org: uniq([...BASE_ORG, ...extra.org ?? []]),
    project: uniq([...resume.projects, ...extra.project ?? []]),
    alias: { ...DEFAULT_ALIAS, ...extra.alias ?? {} },
  };
}

/* ------------------------------------------------------------------ */
/* 抽取                                                                */
/* ------------------------------------------------------------------ */

const NUMBER_RE = /\d+(?:\.\d+)?\s*(?:%|万|千|百|k|K|w|W|个百分点)?/g;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function termPattern(term: string): string {
  const normalized = term.trim().toLowerCase().replace(/\s+/g, ' ');
  // 空格要变成 \s+，否则 "Vue 3" 匹配不到 "Vue  3"
  const body = escapeRe(normalized).replace(/ +/g, '\\s+');
  const hasLatin = /[a-z0-9]/.test(normalized);
  if (!hasLatin) return body;
  // 纯拉丁/数字词要加边界，否则 "Vue" 会命中 "Vuex"，"SSE" 会命中 "asset"。
  // 右边界只挡字母不挡数字，这样 "Vue3" 还能命中 "Vue"。
  return `(?<![a-z0-9])${body}(?![a-z])`;
}

interface Matcher {
  re: RegExp;
  kindOf: Map<string, EntityKind>;
}

function buildMatcher(dict: EntityDict): Matcher | null {
  const kindOf = new Map<string, EntityKind>();
  const entries: Array<{ pattern: string; key: string; kind: EntityKind }> = [];

  const add = (terms: readonly string[], kind: EntityKind) => {
    for (const t of terms) {
      const key = t.trim().toLowerCase().replace(/\s+/g, ' ');
      if (key.length === 0 || kindOf.has(key)) continue;
      kindOf.set(key, kind);
      entries.push({ pattern: termPattern(t), key, kind });
    }
  };
  add(dict.project, 'project');
  add(dict.tech, 'tech');
  add(dict.org, 'org');
  if (entries.length === 0) return null;

  // 长模式优先：否则 "Vue" 会先吃掉 "Vue 3"，把 "3" 留给数字正则造成误报。
  entries.sort((a, b) => b.pattern.length - a.pattern.length || a.key.localeCompare(b.key));

  return { re: new RegExp(entries.map((e) => e.pattern).join('|'), 'gi'), kindOf };
}

const EXEMPT_RULES: Array<{ re: RegExp; reason: string }> = [
  { re: /建议\s*(补充|增加|学习|了解|考取|准备)/, reason: '建议补充类句式' },
  { re: /可以\s*(补充|考虑|尝试)/, reason: '可选动作句式' },
  { re: /(如有|若有|暂无|尚未)/, reason: '条件句（有则更好）' },
  { re: /此处建议补充/, reason: '显式占位符' },
  { re: /(不要求|非必需|加分项)/, reason: '非必需项' },
];

/** 取 index 所在的句子（按中英文句读切分） */
export function sentenceAt(text: string, index: number): string {
  const bounds = /[。；;！!？?\n]/;
  let start = 0;
  for (let i = index - 1; i >= 0; i--) {
    if (bounds.test(text[i])) {
      start = i + 1;
      break;
    }
  }
  let end = text.length;
  for (let i = index; i < text.length; i++) {
    if (bounds.test(text[i])) {
      end = i + 1;
      break;
    }
  }
  return text.slice(start, end);
}

export function exemptReasonOf(sentence: string): string | null {
  for (const r of EXEMPT_RULES) if (r.re.test(sentence)) return r.reason;
  return null;
}

export function extractEntities(
  text: string,
  dict: EntityDict,
  opts: { applyExemption?: boolean } = {},
): Entity[] {
  const applyExemption = opts.applyExemption ?? true;
  const out: Entity[] = [];
  const consumed: Array<[number, number]> = [];

  const overlaps = (s: number, e: number) =>
    consumed.some(([cs, ce]) => s < ce && e > cs);

  const push = (
    raw: string,
    normalized: string,
    kind: EntityKind,
    start: number,
    end: number,
  ) => {
    const sentence = applyExemption ? sentenceAt(text, start) : '';
    const reason = applyExemption ? exemptReasonOf(sentence) : null;
    out.push({
      raw,
      normalized,
      kind,
      start,
      end,
      exempted: reason !== null,
      ...(reason ? { exemptReason: reason } : {}),
    });
    consumed.push([start, end]);
  };

  // 1) 词典词（技术名 / 公司名 / 项目名）
  const matcher = buildMatcher(dict);
  if (matcher) {
    matcher.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = matcher.re.exec(text)) !== null) {
      if (m[0].length === 0) {
        matcher.re.lastIndex++;
        continue;
      }
      const start = m.index;
      const end = start + m[0].length;
      if (overlaps(start, end)) continue;
      const key = m[0].trim().toLowerCase().replace(/\s+/g, ' ');
      const kind = matcher.kindOf.get(key) ?? 'tech';
      push(m[0], normalizeToken(m[0]), kind, start, end);
    }
  }

  // 2) 数字
  NUMBER_RE.lastIndex = 0;
  let nm: RegExpExecArray | null;
  while ((nm = NUMBER_RE.exec(text)) !== null) {
    const start = nm.index;
    const end = start + nm[0].length;
    if (overlaps(start, end)) continue;
    // 日期型 token（2023 / 2023.09 / 2027-06）不是"成绩数字"，容易误报，单独放行
    if (/^(19|20)\d{2}([.\-/]\d{1,2})?$/.test(nm[0].trim())) continue;
    // 序数引用（"第 3 行"）指向的是位置而不是事实，不算实体。
    // 注意要跳过空白往回看，否则 "第 3 行"（中间有空格）会漏判。
    // 这条是实际跑样例时发现的误报来源，写在这里免得以后又踩。
    let p = start - 1;
    while (p >= 0 && /\s/.test(text[p])) p--;
    if (p >= 0 && text[p] === '第') continue;
    // 标识符里的数字（S01、v2、GPT4）不是"成绩数字"。
    // 这条是 demo 跑出来的最贵的那个误报：段 ID "S01" 里的 01 被当成实体，
    // 每个 case 都凭空多出两个"编造"的实体，无源实体率直接从 0.2 抬到 0.56。
    if (p >= 0 && /[A-Za-z]/.test(text[p])) continue;
    const normalized = normalizeNumberLiteral(nm[0]);
    if (normalized === null) continue;
    push(nm[0].trim(), normalized, 'number', start, end);
  }

  return out.sort((a, b) => a.start - b.start);
}

/* ------------------------------------------------------------------ */
/* 出处判定                                                            */
/* ------------------------------------------------------------------ */

export interface SourceIndex {
  /** 归一化后的全文（小写、去空白） */
  flat: string;
  /** 简历里出现过的所有数字（归一化后） */
  numbers: Set<string>;
  /** 每个词典词是否在原文出现过 */
  termHits: Map<string, boolean>;
  /** 原始文本，便于人工核对 */
  raw: string;
}

export function buildSourceIndex(sourceText: string, dict: EntityDict): SourceIndex {
  const numbers = new Set<string>();
  NUMBER_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = NUMBER_RE.exec(sourceText)) !== null) {
    const n = normalizeNumberLiteral(m[0]);
    if (n !== null) numbers.add(n);
  }

  const termHits = new Map<string, boolean>();
  const flat = sourceText.toLowerCase().replace(/\s+/g, ' ');
  const matcher = buildMatcher(dict);
  const seen = new Set<string>();
  if (matcher) {
    matcher.re.lastIndex = 0;
    let mm: RegExpExecArray | null;
    while ((mm = matcher.re.exec(sourceText)) !== null) {
      if (mm[0].length === 0) {
        matcher.re.lastIndex++;
        continue;
      }
      seen.add(mm[0].trim().toLowerCase().replace(/\s+/g, ' '));
    }
  }
  for (const key of matcher?.kindOf.keys() ?? []) termHits.set(key, seen.has(key));
  for (const key of seen) termHits.set(key, true);

  return { flat, numbers, termHits, raw: sourceText };
}

/**
 * 这个实体能不能在原文里找到出处？
 * 注意：判定的是"整份简历"，不做段内限定——否则"建议里提到别段的技能"会被误判为编造。
 */
export function isSourced(entity: Entity, index: SourceIndex): boolean {
  if (entity.kind === 'number') {
    return index.numbers.has(entity.normalized);
  }
  const key = entity.normalized;
  const known = index.termHits.get(key);
  if (known !== undefined) return known;
  // 归一化去掉了版本号，原文里可能是 "react 18"，所以要再做一次宽松子串检查
  return index.flat.includes(key);
}

/* ------------------------------------------------------------------ */
/* 示例片段识别                                                        */
/* ------------------------------------------------------------------ */

/**
 * 示例/模板片段的提示词。出现在引号**之前**才算数。
 */
const EXAMPLE_CUE = /(例如|比如|示例|示意|模板|写法|写成|改成|改为|如[:：]|类似|即[:：]|e\.?g\.?)/i;

/** 片段内部出现明显的占位符，也判定为模板 */
const PLACEHOLDER = /(_{2,}|XX|X{1,2}\s*[个条次天%]|N\s*[个条次])/;

/**
 * 找出文本里"示例/模板"性质的片段，返回 [start, end) 区间。
 *
 * 为什么必须单独识别 —— 这是实测数据教出来的：
 * 接上真实模型后跑第一批，无源实体率算出来 0.43，看着像"模型大面积编造"。
 * 逐条读输出才发现，绝大部分命中的实体长这样：
 *
 *   「建议把这一句拆开，例如：「每 15s 发送心跳 ping，连续 2 次无 pong 判定掉线；
 *     重连采用指数退避（1s→2s→4s→8s，上限 30s）」」
 *
 * 15s / 2 次 / 1s→2s→4s→8s 全都不在简历里，规则判它们"无源"——**技术上讲没错**，
 * 但这些是对候选人的**填写示例**，不是对简历的事实断言。
 * 把它们和"我断定你有 3 年经验"混在一个数字里，指标就废了。
 *
 * 所以：不修改主口径（保守口径照常计入），而是额外识别出这段，
 * 让报告同时给出"扣除示例后的口径"。两个数都摆出来，比只给一个更诚实。
 */
export function exampleSpans(text: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  const pairs: ReadonlyArray<readonly [string, string]> = [
    ['「', '」'],
    ['『', '』'],
  ];
  for (const [open, close] of pairs) {
    let from = 0;
    for (;;) {
      const s = text.indexOf(open, from);
      if (s === -1) break;
      const e = text.indexOf(close, s + 1);
      if (e === -1) break;
      const body = text.slice(s + 1, e);
      const before = text.slice(Math.max(0, s - 15), s);
      if (EXAMPLE_CUE.test(before) || PLACEHOLDER.test(body)) spans.push([s, e + 1]);
      from = e + 1;
    }
  }
  return spans;
}

/** 位置是否落在任一区间内 */
export function inAnySpan(pos: number, spans: ReadonlyArray<readonly [number, number]>): boolean {
  return spans.some(([s, e]) => pos >= s && pos < e);
}
