import type { Suggestion } from '../schema/case.js';

/**
 * 锚点相关指标（策划书 3.3）。
 *
 * 这里修掉了 v1 策划书里的一个可 gaming 的漏洞：
 * v1 的"关键词召回率" = 报告覆盖的 JD 硬门槛词 / 硬门槛词总数。
 * 只要模型把 JD 里的词原样抄进建议里，这个指标就能刷到 100%，毫无意义。
 *
 * 现在的口径是「带锚点的硬门槛覆盖率」：只有**绑定了简历段落 ID**的建议才计入。
 * 抄词不算数，必须指得出这句话是改简历的哪一段。
 */

function norm(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, '');
}

export interface GateCoverageResult {
  /** 被覆盖的硬门槛词 */
  covered: string[];
  /** 没被覆盖的硬门槛词 —— 这是"缺失项"列表，直接给用户看 */
  missing: string[];
  rate: number;
  /** 带锚点的建议条数 */
  anchoredCount: number;
  /** 建议总条数 */
  totalCount: number;
}

export function hardGateCoverage(
  suggestions: readonly Suggestion[],
  hardReq: readonly string[],
): GateCoverageResult {
  const anchored = suggestions.filter((s) => s.anchor_seg_id !== null);
  const anchoredText = norm(anchored.map((s) => s.text).join('\n'));

  const covered: string[] = [];
  const missing: string[] = [];
  for (const gate of hardReq) {
    if (anchoredText.includes(norm(gate))) covered.push(gate);
    else missing.push(gate);
  }

  return {
    covered,
    missing,
    rate: hardReq.length === 0 ? 0 : covered.length / hardReq.length,
    anchoredCount: anchored.length,
    totalCount: suggestions.length,
  };
}

export interface AnchorCoverageResult {
  anchoredCount: number;
  totalCount: number;
  /** 锚点覆盖率 = 绑定了段 ID 的建议条数 / 总建议条数 */
  rate: number;
  /** 无出处的建议 —— 这些是最可能编造的部分，需要单列给人工看 */
  unsourcedSuggestions: Suggestion[];
}

export function anchorCoverage(suggestions: readonly Suggestion[]): AnchorCoverageResult {
  const anchored = suggestions.filter((s) => s.anchor_seg_id !== null);
  return {
    anchoredCount: anchored.length,
    totalCount: suggestions.length,
    rate: suggestions.length === 0 ? 0 : anchored.length / suggestions.length,
    unsourcedSuggestions: suggestions.filter((s) => s.anchor_seg_id === null),
  };
}

/**
 * 锚点正确率：抽 N 条,人工核对"这个段 ID 是否真的支撑这条建议"。
 *
 * 为什么必须单独做这个：锚点覆盖率只数了"有没有挂锚点"，
 * 而模型完全可能随便挂一个段 ID 来凑覆盖率。
 * 所以覆盖率 + 正确率要一起报，缺一个都有漏洞。
 */
export interface AnchorAuditResult {
  n: number;
  correct: number;
  rate: number;
  /** 挂错锚点的样本，用于人工复核 */
  wrong: Array<{ suggestion_id: string; anchor_seg_id: string; reason: string }>;
}

export function anchorCorrectness(
  audits: ReadonlyArray<{
    suggestion_id: string;
    anchor_seg_id: string;
    human_correct: boolean;
    reason?: string;
  }>,
): AnchorAuditResult {
  const correct = audits.filter((a) => a.human_correct).length;
  return {
    n: audits.length,
    correct,
    rate: audits.length === 0 ? 0 : correct / audits.length,
    wrong: audits
      .filter((a) => !a.human_correct)
      .map((a) => ({
        suggestion_id: a.suggestion_id,
        anchor_seg_id: a.anchor_seg_id,
        reason: a.reason ?? '人工判定锚点不支撑该建议',
      })),
  };
}
