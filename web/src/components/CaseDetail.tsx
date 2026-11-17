import { useEffect, useMemo, useState } from 'react';
import type { CaseDetailResult, CaseMeta, CaseRunDetail, ProfileMeta, Span } from '../types';
import { api } from '../api';
import { Tag } from './Badge';

/**
 * Case 详情视图：把「一个 case 在某档位下」从输入到产出的完整链路摊开——
 *   · 左边：简历（脱敏分段）+ JD 硬门槛，这是模型看到的输入；
 *   · 中间：3 次重复运行的产出（建议 + 锚点），这是「时好时坏」的直接证据；
 *   · 右边：某一次运行的 trace 瀑布图，拆成 4 步看「哪一步烧了 token / 花了时间」。
 *
 * 这个视图的存在，是为了回答面试里最锋利的一句追问：
 *   「你榜单上的一个数字，往下钻一层是什么样子的？」——这里就是那一层。
 */

const KIND_LABEL: Record<string, string> = { hit: '命中', missing: '缺口', improve: '改进' };
const KIND_TONE: Record<string, 'good' | 'warn' | 'accent'> = { hit: 'good', missing: 'warn', improve: 'accent' };

const EXP_LABEL: Record<string, string> = {
  rich: '经历丰富',
  thin: '经历单薄',
  career_change: '转行',
  incomplete: '字段残缺',
};

const CAT_LABEL: Record<string, string> = {
  app: 'AI 应用前端',
  platform: 'AI 平台前端',
  data: '数据平台',
  business: '普通业务前端',
};

function fmtMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function fmtTokens(t: { input: number; output: number } | null): string {
  if (!t) return '—';
  return `${t.input}+${t.output}`;
}

/* ------------------------------------------------------------------ */
/* 建议列表                                                            */
/* ------------------------------------------------------------------ */

function RunSuggestions({ run }: { run: CaseRunDetail }) {
  if (run.error) {
    return <div className="run-error">⚠️ 本次运行失败：{run.error}</div>;
  }
  if (run.suggestions.length === 0) {
    return <div className="dim small">本次无产出。</div>;
  }
  return (
    <ul className="sugg-list">
      {run.suggestions.map((s) => (
        <li key={s.id} className="sugg-item">
          <span className={`tag tag-${KIND_TONE[s.kind] ?? 'neutral'}`}>{KIND_LABEL[s.kind] ?? s.kind}</span>
          <span className="sugg-text">{s.text}</span>
          {s.anchor_seg_id ? (
            <code className="anchor" title="出处段 ID">↳ {s.anchor_seg_id}</code>
          ) : (
            <code className="anchor none" title="无出处：建议没有绑定到简历原文">↳ 无出处</code>
          )}
        </li>
      ))}
    </ul>
  );
}

/* ------------------------------------------------------------------ */
/* trace 瀑布图                                                        */
/* ------------------------------------------------------------------ */

const SPAN_TONE: Record<string, string> = {
  agent: 'span-agent',
  llm: 'span-llm',
  tool: 'span-tool',
  retrieval: 'span-retrieval',
  render: 'span-render',
};

const SPAN_LABEL: Record<string, string> = {
  agent: 'agent',
  llm: 'LLM',
  tool: 'tool',
  retrieval: '检索',
  render: '渲染',
};

function TraceWaterfall({ spans }: { spans: Span[] }) {
  if (spans.length === 0) {
    return <div className="empty-card">本次运行没有 trace 数据（可能在落盘 trace 之前就失败，或数据源无 trace）。</div>;
  }

  // 时间轴以 root span（start 最小）为 0 点，覆盖到 end 最大
  const minStart = Math.min(...spans.map((s) => s.start));
  const maxEnd = Math.max(...spans.map((s) => s.end));
  const total = Math.max(1, maxEnd - minStart);

  // 按 start 排序；root（parent 为 null）自然排最前
  const sorted = [...spans].sort((a, b) => a.start - b.start || a.span_id.localeCompare(b.span_id));

  const depthOf = (s: Span): number => (s.parent_id === null ? 0 : 1);
  const maxDepth = Math.max(...sorted.map(depthOf));
  const root = sorted.find((s) => s.parent_id === null);

  return (
    <div className="waterfall">
      <div className="waterfall-head">
        <span>总耗时 {fmtMs(root ? root.end - root.start : total)}</span>
        <span className="dim small">横轴 = 时间（相对 root 起点），条宽 = 该步耗时</span>
      </div>
      <div className="waterfall-rows">
        {sorted.map((s) => {
          const left = ((s.start - minStart) / total) * 100;
          const width = Math.max(0.6, ((s.end - s.start) / total) * 100);
          const dur = s.end - s.start;
          const depth = depthOf(s);
          return (
            <div key={s.span_id} className="wf-row" style={{ paddingLeft: depth * 22 + 8 }}>
              <div className="wf-label">
                <span className={`wf-dot ${SPAN_TONE[s.type] ?? 'span-agent'}`} />
                <span className="wf-name">{s.name}</span>
                <span className="wf-meta dim small">
                  {SPAN_LABEL[s.type] ?? s.type} · {fmtTokens(s.tokens)} tok · {fmtMs(dur)}
                  {s.error ? ' · ⚠️' : ''}
                </span>
              </div>
              <div className="wf-track">
                <div
                  className={`wf-bar ${SPAN_TONE[s.type] ?? 'span-agent'}${s.error ? ' wf-bar-err' : ''}`}
                  style={{ left: `${left}%`, width: `${width}%` }}
                  title={`${s.name}：${fmtMs(dur)}${s.tokens ? ` · ${s.tokens.input}+${s.tokens.output} tok` : ''}${s.error ? ` · 错误：${s.error}` : ''}`}
                />
              </div>
            </div>
          );
        })}
      </div>
      <div className="waterfall-legend dim small">
        <span><span className="wf-dot span-llm" /> LLM 调用</span>
        <span><span className="wf-dot span-tool" /> 确定性工具</span>
        <span><span className="wf-dot span-agent" /> 整体</span>
        {maxDepth > 1 && <span>缩进表示父子层级（并行调用会多叉）</span>}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 主组件                                                              */
/* ------------------------------------------------------------------ */

export function CaseDetail({ profiles }: { profiles: ProfileMeta[] }) {
  const [cases, setCases] = useState<CaseMeta[]>([]);
  const [runId, setRunId] = useState('');
  const [caseId, setCaseId] = useState('');
  const [data, setData] = useState<CaseDetailResult | null>(null);
  const [runIndex, setRunIndex] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .cases()
      .then((r) => {
        if (alive) setCases(r.cases);
      })
      .catch((e) => {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (profiles.length && !runId) setRunId(profiles[0].run_id);
  }, [profiles, runId]);

  useEffect(() => {
    if (cases.length && !caseId) setCaseId(cases[0].case_id);
  }, [cases, caseId]);

  useEffect(() => {
    if (!runId || !caseId) return;
    let alive = true;
    setLoading(true);
    setError(null);
    api
      .caseDetail(runId, caseId)
      .then((d) => {
        if (!alive) return;
        setData(d);
        setRunIndex(0);
      })
      .catch((e) => {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [runId, caseId]);

  const selectedRun = useMemo(
    () => data?.runs.find((r) => r.run_index === runIndex) ?? data?.runs[0] ?? null,
    [data, runIndex],
  );

  const caseMeta = useMemo(() => cases.find((c) => c.case_id === caseId), [cases, caseId]);

  return (
    <div className="case-view">
      <div className="selector-bar">
        <label>
          档位
          <select value={runId} onChange={(e) => setRunId(e.target.value)}>
            {profiles.map((p) => (
              <option key={p.run_id} value={p.run_id}>
                {p.model_label} · {p.prompt_version}
              </option>
            ))}
          </select>
        </label>
        <label>
          Case
          <select value={caseId} onChange={(e) => setCaseId(e.target.value)}>
            {cases.map((c) => (
              <option key={c.case_id} value={c.case_id}>
                {c.case_id} · {CAT_LABEL[c.tags.category] ?? c.tags.category}
              </option>
            ))}
          </select>
        </label>
        <div className="selector-meta">
          {caseMeta && (
            <>
              <Tag tone="neutral">{EXP_LABEL[caseMeta.tags.experience_level] ?? caseMeta.tags.experience_level}</Tag>
              <Tag tone="neutral">{caseMeta.tags.level}</Tag>
              {caseMeta.is_hard_negative && <Tag tone="warn">难例</Tag>}
              {caseMeta.is_golden && <Tag tone="accent">金标</Tag>}
            </>
          )}
        </div>
      </div>

      {loading && <div className="empty-card">正在加载 case 详情…</div>}
      {error && <div className="error-card">{error}</div>}

      {data && !loading && (
        <>
          {/* 输入侧：模型看到什么 */}
          <div className="case-inputs">
            <div className="case-col">
              <h3 className="case-col-title">📄 简历（脱敏） · {data.resume.anon_id}</h3>
              <p className="dim small">{data.resume.headline}</p>
              <div className="seg-list">
                {data.resume.segments.map((seg) => (
                  <div key={seg.seg_id} className="seg">
                    <code className="seg-id">{seg.seg_id}</code>
                    <span className="seg-text">{seg.text}</span>
                  </div>
                ))}
              </div>
            </div>
            <div className="case-col">
              <h3 className="case-col-title">🎯 JD 硬门槛 · {data.jd.title}</h3>
              <ul className="hard-req">
                {data.jd.hard_req.map((h, i) => (
                  <li key={i}>{h}</li>
                ))}
              </ul>
              <p className="dim small" style={{ marginTop: 10 }}>
                这就是「锚点覆盖率」要对照检查的那份要求清单；建议必须能回溯到简历的某个段 ID。
              </p>
            </div>
          </div>

          {/* 重复运行：稳定性的直接证据 */}
          <div className="case-runs">
            <div className="case-runs-head">
              <h3>三次重复运行（pass³ 的原始数据）</h3>
              <div className="run-tabs">
                {data.runs.map((r) => (
                  <button
                    key={r.run_index}
                    className={r.run_index === runIndex ? 'run-tab active' : 'run-tab'}
                    onClick={() => setRunIndex(r.run_index)}
                  >
                    run #{r.run_index + 1}
                  </button>
                ))}
              </div>
            </div>

            {selectedRun && (
              <div className="run-detail">
                <div className="run-stats">
                  <span className="stat-mini">token <b>{selectedRun.input_tokens + selectedRun.output_tokens}</b></span>
                  <span className="stat-mini">成本 <b>¥{selectedRun.cost_cny.toFixed(4)}</b></span>
                  <span className="stat-mini">耗时 <b>{fmtMs(selectedRun.latency_ms)}</b></span>
                  {selectedRun.invalid_anchors.length > 0 && (
                    <span className="stat-mini warn">伪造锚点 <b>{selectedRun.invalid_anchors.length}</b>（{selectedRun.invalid_anchors.join(', ')}）</span>
                  )}
                </div>
                <RunSuggestions run={selectedRun} />
              </div>
            )}

            <h3 className="case-col-title" style={{ marginTop: 18 }}>trace 瀑布图（本次运行的 4 步）</h3>
            {selectedRun && <TraceWaterfall spans={selectedRun.spans} />}
          </div>
        </>
      )}
    </div>
  );
}
