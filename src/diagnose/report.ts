/**
 * 单条诊断的报告渲染 —— 纯函数，不读文件、不发请求，方便单测。
 *
 * 两套输出共用同一份 `DiagnoseReport`：
 *   · `renderTerminal`  —— 人坐在终端前看的，重点是"我现在该改哪一句"
 *   · `renderMarkdown`  —— 落到 reports/ 留档、发给别人看的
 *
 * 刻意把两者分开写而不是"一份 Markdown 顺便当终端输出"：
 * 终端里表格会折行折得很难读，而 Markdown 里用 `\r` 刷新进度行毫无意义。
 */

import type { SuggestionKind } from '../schema/case.js';

export interface GateRow {
  gate: string;
  verdict: 'hit' | 'partial' | 'missing';
  /** 支撑这条判定的简历段 ID（已被校验过存在性） */
  evidence: string[];
  reason: string;
}

export interface SuggestionRow {
  kind: SuggestionKind;
  text: string;
  /** 锚点段 ID；null = 无出处 */
  anchor: string | null;
  /** 锚点段原文（截断后）；null = 无出处或段 ID 不存在于简历 */
  anchorText: string | null;
}

export interface DiagnoseReport {
  generatedAt: string;
  resumePath: string;
  jdPath: string;
  jdTitle: string;
  categoryLabel: string;
  levelLabel: string;
  experienceLabel: string;
  profile: { runId: string; modelLabel: string; promptVersion: string };
  runs: number;
  segmentCount: number;
  warnings: string[];
  gates: GateRow[];
  suggestions: SuggestionRow[];
  metrics: {
    anchorRate: number;
    anchoredCount: number;
    totalCount: number;
    /** 无源实体率（严口径） */
    unsourcedRate: number;
    /** 被判定为"编了但简历里没有"的实体 top N */
    unsourcedTop: Array<{ entity: string; count: number }>;
    /** 模型回填了但不存在的段 ID —— 不置空就会污染锚点覆盖率 */
    invalidAnchors: string[];
    /** 用「建议文本里有没有出现门槛原词」做的保守交叉校验 */
    strictGateRate: number;
    strictMissing: string[];
  };
  cost: {
    cny: number;
    inputTokens: number;
    outputTokens: number;
    latencyMs: number;
  };
  steps: Array<{ name: string; ms: number; inputTokens: number; outputTokens: number; error: string | null }>;
  /** Agent 整体失败时的原因；此时 suggestions/gates 都为空 */
  error: string | null;
  artifacts: { runsFile: string; inputsFile: string; reportPath: string } | null;
}

export const GATE_LABEL: Record<GateRow['verdict'], string> = {
  hit: '✅ 命中',
  partial: '◐ 部分',
  missing: '❌ 缺失',
};

export const KIND_LABEL: Record<SuggestionKind, string> = {
  improve: '改进',
  missing: '补缺',
  hit: '已命中',
};

export function clip(text: string, max = 58): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`;
}

export function pct(v: number): string {
  return `${(v * 100).toFixed(1)}%`;
}

/** 门禁统计：命中 / 部分 / 缺失 各几条 */
export function gateTally(gates: readonly GateRow[]): Record<GateRow['verdict'], number> {
  const out: Record<GateRow['verdict'], number> = { hit: 0, partial: 0, missing: 0 };
  for (const g of gates) out[g.verdict]++;
  return out;
}

/** 把建议按 kind 分组，组内保持模型输出顺序（不改顺序：顺序本身也是信息） */
export function groupByKind(rows: readonly SuggestionRow[]): Array<[SuggestionKind, SuggestionRow[]]> {
  const order: SuggestionKind[] = ['missing', 'improve', 'hit'];
  return order
    .map((k) => [k, rows.filter((r) => r.kind === k)] as [SuggestionKind, SuggestionRow[]])
    .filter(([, list]) => list.length > 0);
}

/* ------------------------------------------------------------------ */
/* 终端版                                                              */
/* ------------------------------------------------------------------ */

export function renderTerminal(r: DiagnoseReport): string {
  const L: string[] = [];
  const hr = '─'.repeat(64);

  L.push(hr);
  L.push('OfferLens · 单份简历诊断');
  L.push(hr);
  L.push(`简历    ${r.resumePath}（${r.segmentCount} 段）`);
  L.push(`岗位    ${r.jdTitle}　${r.categoryLabel} / ${r.levelLabel}`);
  L.push(`档位    ${r.profile.modelLabel} · ${r.profile.promptVersion}（${r.profile.runId}）`);
  if (r.runs > 1) L.push(`重复    ${r.runs} 次（下面展示第 1 次，其余见 JSON / 报告）`);

  if (r.warnings.length > 0) {
    L.push('');
    L.push('分段提示：');
    for (const w of r.warnings) L.push(`  · ${w}`);
  }

  if (r.error !== null) {
    L.push('');
    L.push(`❌ 这次诊断没有跑完：${r.error}`);
    L.push('   常见原因：key 无效 / 模型返回的不是 JSON / 额度不足。原始 trace 已写盘，可查。');
    return L.join('\n');
  }

  /* ---------- 硬门槛 ---------- */
  const tally = gateTally(r.gates);
  L.push('');
  L.push(`一、硬门槛核对（${r.gates.length} 条：命中 ${tally.hit} · 部分 ${tally.partial} · 缺失 ${tally.missing}）`);
  L.push('    门槛由模型从 JD 原文抽出，未经人工标注 —— 它可能抽漏，别当成招聘方的正式标准。');
  for (const g of r.gates) {
    const ev = g.evidence.length > 0 ? `　证据 ${g.evidence.join('、')}` : '';
    L.push(`  ${GATE_LABEL[g.verdict]}  ${g.gate}${ev}`);
    if (g.reason.length > 0) L.push(`         ${clip(g.reason, 72)}`);
  }

  /* ---------- 建议 ---------- */
  L.push('');
  L.push(
    `二、建议（${r.suggestions.length} 条，带出处 ${r.metrics.anchoredCount} 条 / 无出处 ${
      r.metrics.totalCount - r.metrics.anchoredCount
    } 条）`,
  );
  for (const [kind, list] of groupByKind(r.suggestions)) {
    L.push(`  【${KIND_LABEL[kind]}】${list.length} 条`);
    for (const s of list) {
      L.push(`   · ${s.text}`);
      if (s.anchor !== null) {
        L.push(`     出处 ${s.anchor}「${clip(s.anchorText ?? '', 56)}」`);
      } else {
        L.push('     出处 ——（这条没有指到具体某一段，最可能是套话或编造）');
      }
    }
  }

  /* ---------- 口径自检 ---------- */
  L.push('');
  L.push('三、口径自检');
  L.push(
    `  带锚点覆盖率 ${pct(r.metrics.anchorRate)}（${r.metrics.anchoredCount}/${r.metrics.totalCount}）` +
      '　—— 越低说明越多建议没落到具体某一句上',
  );
  L.push(
    `  无源实体率   ${pct(r.metrics.unsourcedRate)}（严口径：建议里出现、但简历与 JD 里都没有的数字/技术名/公司名）`,
  );
  if (r.metrics.unsourcedTop.length > 0) {
    L.push(`  最可疑的词   ${r.metrics.unsourcedTop.map((t) => `${t.entity}×${t.count}`).join('、')}`);
  }
  if (r.metrics.invalidAnchors.length > 0) {
    L.push(
      `  假锚点       ${r.metrics.invalidAnchors.length} 个（${r.metrics.invalidAnchors.join('、')}）：` +
        '简历里根本没有这些段，已置空、不计入覆盖率',
    );
  }
  L.push(
    `  严格逐字口径 门槛原词出现在建议里 ${pct(r.metrics.strictGateRate)}` +
      (r.metrics.strictMissing.length > 0
        ? `，未逐字出现：${r.metrics.strictMissing.join('、')}\n` +
          '                （命中 ≠ 逐字重复：模型会改写措辞，这个数字天然偏低，只用来看"有没有完全没提到"）'
        : ''),
  );

  /* ---------- 成本 ---------- */
  L.push('');
  L.push('四、成本与耗时');
  L.push(
    `  ¥${r.cost.cny.toFixed(4)} · ${r.cost.inputTokens} in / ${r.cost.outputTokens} out · ${(r.cost.latencyMs / 1000).toFixed(1)}s`,
  );
  for (const s of r.steps) {
    const tok = s.inputTokens + s.outputTokens > 0 ? `${s.inputTokens}+${s.outputTokens} tok` : 'tool';
    L.push(`   · ${s.name.padEnd(15)} ${(s.ms / 1000).toFixed(2)}s　${tok}${s.error ? `　❌ ${clip(s.error, 40)}` : ''}`);
  }

  if (r.artifacts) {
    L.push('');
    L.push(`报告 ${r.artifacts.reportPath}`);
    L.push(`原始 ${r.artifacts.runsFile}`);
  }

  L.push('');
  L.push('注意：单次诊断不是"正确答案"。它只说明这一次模型怎么读你的简历；');
  L.push('      想判断结论稳不稳，用 --runs 3 看两次以上是否给出同样的建议。');
  return L.join('\n');
}

/* ------------------------------------------------------------------ */
/* Markdown 版                                                         */
/* ------------------------------------------------------------------ */

export function renderMarkdown(r: DiagnoseReport): string {
  const out: string[] = [];
  const tally = gateTally(r.gates);

  out.push('# 简历诊断报告（单条真实输入）');
  out.push('');
  out.push(`> 生成时间：${r.generatedAt}`);
  out.push(
    `> 档位：\`${r.profile.runId}\`（${r.profile.modelLabel} · ${r.profile.promptVersion}）　重复 ${r.runs} 次`,
  );
  out.push(`> 输入：\`${r.resumePath}\`（${r.segmentCount} 段）× \`${r.jdPath}\``);
  out.push('');
  out.push(
    '> ⚠️ 这是一次**单条诊断**，不是评测结论：没有重复采样，也没有人工标注，' +
      '它只代表"这一次模型怎么读你的简历"。',
  );
  out.push('');

  if (r.warnings.length > 0) {
    out.push('## 分段提示');
    out.push('');
    for (const w of r.warnings) out.push(`- ${w}`);
    out.push('');
  }

  if (r.error !== null) {
    out.push('## 运行失败');
    out.push('');
    out.push('```');
    out.push(r.error);
    out.push('```');
    out.push('');
    out.push(`原始 trace 见 \`${r.artifacts?.runsFile ?? 'data/live/'}\`。`);
    return `${out.join('\n')}\n`;
  }

  out.push('## 一、硬门槛核对');
  out.push('');
  out.push(
    `${r.gates.length} 条：命中 ${tally.hit} · 部分 ${tally.partial} · 缺失 ${tally.missing}。` +
      '门槛由模型从 JD 原文抽出（未经人工标注），抽漏是已知风险。',
  );
  out.push('');
  out.push('| 判定 | 门槛 | 证据段 | 说明 |');
  out.push('| --- | --- | --- | --- |');
  for (const g of r.gates) {
    out.push(
      `| ${GATE_LABEL[g.verdict]} | ${esc(g.gate)} | ${g.evidence.length > 0 ? g.evidence.join('、') : '—'} | ${esc(
        g.reason || '—',
      )} |`,
    );
  }
  out.push('');

  out.push('## 二、建议');
  out.push('');
  out.push(
    `共 ${r.suggestions.length} 条，带出处 ${r.metrics.anchoredCount} 条，无出处 ${
      r.metrics.totalCount - r.metrics.anchoredCount
    } 条。`,
  );
  out.push('');
  for (const [kind, list] of groupByKind(r.suggestions)) {
    out.push(`### ${KIND_LABEL[kind]}（${list.length}）`);
    out.push('');
    for (const s of list) {
      const anchor =
        s.anchor === null ? '**无出处**（最可能是套话或编造）' : `${s.anchor}「${esc(clip(s.anchorText ?? '', 60))}」`;
      out.push(`- ${s.text}`);
      out.push(`  - 出处：${anchor}`);
    }
    out.push('');
  }

  out.push('## 三、口径自检');
  out.push('');
  out.push('| 指标 | 值 | 怎么读 |');
  out.push('| --- | ---: | --- |');
  out.push(
    `| 带锚点覆盖率 | ${pct(r.metrics.anchorRate)}（${r.metrics.anchoredCount}/${r.metrics.totalCount}） | 越低说明越多建议没落到具体某一句 |`,
  );
  out.push(
    `| 无源实体率 | ${pct(r.metrics.unsourcedRate)} | 建议里出现、但简历与 JD 里都没有的数字/技术名/公司名 |`,
  );
  out.push(
    `| 假锚点数 | ${r.metrics.invalidAnchors.length} | 模型编出来的段 ID，已置空且不计入覆盖率 |`,
  );
  out.push(
    `| 门槛原词交叉校验 | ${pct(r.metrics.strictGateRate)} | 严格逐字口径：建议里是否**逐字**出现了门槛原词。命中≠逐字重复，模型会改写措辞，所以这个值天然偏低 |`,
  );
  out.push('');
  if (r.metrics.unsourcedTop.length > 0) {
    out.push(
      `最可疑的实体：${r.metrics.unsourcedTop.map((t) => `\`${t.entity}\`×${t.count}`).join('、')}`,
    );
    out.push('');
  }
  if (r.metrics.invalidAnchors.length > 0) {
    out.push(`被丢弃的假锚点：${r.metrics.invalidAnchors.map((a) => `\`${a}\``).join('、')}`);
    out.push('');
  }

  out.push('## 四、成本与耗时');
  out.push('');
  out.push(
    `¥${r.cost.cny.toFixed(4)} · ${r.cost.inputTokens} in / ${r.cost.outputTokens} out · ${(
      r.cost.latencyMs / 1000
    ).toFixed(1)}s`,
  );
  out.push('');
  out.push('| 步骤 | 耗时 | token | 错误 |');
  out.push('| --- | ---: | ---: | --- |');
  for (const s of r.steps) {
    out.push(
      `| \`${s.name}\` | ${(s.ms / 1000).toFixed(2)}s | ${s.inputTokens}+${s.outputTokens} | ${esc(s.error ?? '—')} |`,
    );
  }
  out.push('');

  out.push('## 已知限制');
  out.push('');
  out.push(`- 单次运行，没有重复采样。判断稳定性请用 \`--runs 3\` 再看一遍。`);
  out.push('- 硬门槛是模型抽的，不是招聘方给的；抽漏会导致"看起来都命中"。');
  out.push('- 无源实体率是**代理指标**：它测的是"建议有没有编造具体数字/技术名"，不等于"建议对不对"。');
  out.push('- 与批量评测的口径差异：批量评测用数据集里人工标注的 `hard_req`，这里用模型当场抽的，两者不可直接相加比较。');
  out.push('- 简历若是双栏排版或表格排版，导出成纯文本后顺序会乱，锚点会指错段 —— 请先整理成"一段一行"。');
  out.push('');

  if (r.artifacts) {
    out.push('## 原始记录');
    out.push('');
    out.push(`- 运行记录：\`${r.artifacts.runsFile}\``);
    out.push(`- 输入快照：\`${r.artifacts.inputsFile}\``);
    out.push('');
  }

  return `${out.join('\n')}\n`;
}

function esc(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}
