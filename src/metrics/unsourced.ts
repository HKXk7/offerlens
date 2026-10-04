import type { Suggestion } from '../schema/case.js';
import {
  buildSourceIndex,
  exampleSpans,
  extractEntities,
  inAnySpan,
  isSourced,
  type Entity,
  type EntityDict,
  type SourceIndex,
} from './entities.js';

/**
 * 无源实体率 —— 这个项目的独家指标（策划书 2.2 / 3.3）。
 *
 * 定义：建议中"被判为无出处"的实体数 ÷ 建议中识别出的实体总数（豁免的实体不计入分母）。
 * 其中**"源" = 模型的全部输入文档**（简历正文 + JD 原文）。
 *
 * 为什么不用"幻觉率"这个名字：幻觉是与事实相反，而我们只能验证"有没有出处"。
 * 一个措辞诚实、边界清楚的名字，比一个听起来更唬人的名字更经得起追问。
 *
 * ⚠️ 口径是两轮真实数据逼出来的，两条都写在这里免得以后又踩：
 *
 * ① **源必须含 JD**。只算简历时，"岗位要求「熟悉 Vue」，简历只有 React" 这类
 *    正确的缺口分析会被整条判成编造（真实数据里 tech:vue 出现 252 次，误报第一）。
 *
 * ② **示例/模板要单独识别**。模型爱给填写示例（例如「每 15s 发心跳 ping」），
 *    这些数字不在任何输入里，但它们是**模板**而不是对简历的断言。
 *    所以本模块给两个口径：
 *      · rate                   —— 严口径，示例里的实体也算无源（默认）
 *      · rateExcludingExamples  —— 只统计"对简历的断言"里的无源实体
 *    两个数都报。哪个更对取决于想问什么，不该由代码单方面决定。
 *
 * 仍然已知、但**故意没修**的误报：裸小整数（"岗位职责 1、2"里的 1 和 2）。
 * 想修得有依据 —— 需要人工标注来判断哪些数字算"事实断言"，详见 detectorCalibration。
 */

export interface EntityVerdict {
  suggestion_id: string;
  case_id: string;
  run_id: string;
  entity: Entity;
  /** 规则判定：这条实体是否"无出处" */
  rule_unsourced: boolean;
  /** 是否豁免（建议补充类句式）——豁免的实体既不算分子也不算分母 */
  exempted: boolean;
  /** 是否落在"示例/模板"片段内（如「…」） */
  in_example: boolean;
}

export interface UnsourcedRateResult {
  /** 参与计算的实体总数（不含豁免） */
  considered: number;
  /** 判为无出处的实体数 */
  unsourced: number;
  exempted: number;
  total: number;
  /** 无源实体率 = unsourced / considered */
  rate: number;
  /**
   * 扣除"示例/模板片段"内的实体后的无源实体率。
   * 与 rate 一起报，两个口径的差距本身就是一条结论。
   */
  rateExcludingExamples: number;
  /** 落在示例片段内的实体条数（仍计入上面的 rate） */
  exampleLocated: number;
  /** 按建议条聚合的比例（避免一条长建议里塞 20 个实体就把整组拉偏） */
  perSuggestion: number[];
  /** 高亮用：最"脏"的实体 top N */
  topOffenders: Array<{ entity: string; count: number }>;
}

export function auditSuggestion(
  suggestion: Suggestion,
  index: SourceIndex,
  dict: EntityDict,
): EntityVerdict[] {
  const entities = extractEntities(suggestion.text, dict);
  const spans = exampleSpans(suggestion.text);
  return entities.map((entity) => ({
    suggestion_id: suggestion.id,
    case_id: suggestion.case_id,
    run_id: suggestion.run_id,
    entity,
    rule_unsourced: !entity.exempted && !isSourced(entity, index),
    exempted: entity.exempted,
    in_example: inAnySpan(entity.start, spans),
  }));
}

export function auditSuggestions(
  suggestions: readonly Suggestion[],
  sourceText: string,
  dict: EntityDict,
): EntityVerdict[] {
  const index = buildSourceIndex(sourceText, dict);
  return suggestions.flatMap((s) => auditSuggestion(s, index, dict));
}

export function unsourcedRate(verdicts: readonly EntityVerdict[]): UnsourcedRateResult {
  const considered = verdicts.filter((v) => !v.exempted);
  const unsourced = considered.filter((v) => v.rule_unsourced);
  const exempted = verdicts.length - considered.length;

  // 松口径：把落在「例如：「…」」这类填写示例里的实体排除掉再看
  const nonExample = considered.filter((v) => !v.in_example);
  const nonExampleUnsourced = nonExample.filter((v) => v.rule_unsourced);
  const exampleLocated = considered.filter((v) => v.in_example).length;

  const bySuggestion = new Map<string, { total: number; bad: number }>();
  for (const v of considered) {
    const cur = bySuggestion.get(v.suggestion_id) ?? { total: 0, bad: 0 };
    cur.total++;
    if (v.rule_unsourced) cur.bad++;
    bySuggestion.set(v.suggestion_id, cur);
  }
  const perSuggestion = [...bySuggestion.values()].map((s) => (s.total === 0 ? 0 : s.bad / s.total));

  const counter = new Map<string, number>();
  for (const v of unsourced) {
    counter.set(v.entity.normalized, (counter.get(v.entity.normalized) ?? 0) + 1);
  }
  const topOffenders = [...counter.entries()]
    .map(([entity, count]) => ({ entity, count }))
    .sort((a, b) => b.count - a.count || a.entity.localeCompare(b.entity))
    .slice(0, 10);

  return {
    considered: considered.length,
    unsourced: unsourced.length,
    exempted,
    total: verdicts.length,
    rate: considered.length === 0 ? 0 : unsourced.length / considered.length,
    rateExcludingExamples:
      nonExample.length === 0 ? 0 : nonExampleUnsourced.length / nonExample.length,
    exampleLocated,
    perSuggestion,
    topOffenders,
  };
}

/* ------------------------------------------------------------------ */
/* 检测器校准：规则 vs 人工                                            */
/* ------------------------------------------------------------------ */

export interface CalibrationResult {
  n: number;
  tp: number;
  fp: number;
  fn: number;
  tn: number;
  /** 规则判"无源"的准不准 */
  precision: number;
  /** 真·无源的有没有被漏掉 */
  recall: number;
  f1: number;
  /** 误报案例，用于人工复核后改词典 */
  falsePositives: string[];
  /** 漏报案例，通常说明词典缺词 */
  falseNegatives: string[];
}

/**
 * 用人工判定校准规则检测器。
 *
 * 这是回答"你这套规则凭什么可信"的唯一正确方式：
 * 不是声称规则很准，而是拿一批人工判定去量它，并且把误报/漏报的具体样本列出来。
 * 样本量必须 ≥ 40——20 条的时候，错 2 条就是"90%"，95% 置信区间宽到 68%–99%。
 */
export function detectorCalibration(
  cases: ReadonlyArray<{ entity: string; rule_unsourced: boolean; human_unsourced: boolean }>,
): CalibrationResult {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let tn = 0;
  const falsePositives: string[] = [];
  const falseNegatives: string[] = [];

  for (const c of cases) {
    if (c.rule_unsourced && c.human_unsourced) tp++;
    else if (c.rule_unsourced && !c.human_unsourced) {
      fp++;
      falsePositives.push(c.entity);
    } else if (!c.rule_unsourced && c.human_unsourced) {
      fn++;
      falseNegatives.push(c.entity);
    } else tn++;
  }

  const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 0 : tp / (tp + fn);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);

  return {
    n: cases.length,
    tp, fp, fn, tn,
    precision, recall, f1,
    falsePositives,
    falseNegatives,
  };
}
