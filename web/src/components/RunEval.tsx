import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { EvalJob, EvalProgress, EvalSummary, ProfileMeta } from '../types';

interface Props {
  profiles: ProfileMeta[];
  /** 评测完成（done）后回调，用于刷新榜单/对比等只读数据 */
  onEvalDone: () => void;
}

/** 给 EventSource 加自定义事件监听，自动 JSON 反序列化。 */
function onEvent<T>(es: EventSource, event: string, fn: (data: T) => void): void {
  es.addEventListener(event, ((e: Event) => {
    const me = e as MessageEvent;
    try {
      fn(JSON.parse(me.data) as T);
    } catch {
      /* 忽略单条解析失败 */
    }
  }) as EventListener);
}

const STATUS_TEXT: Record<EvalJob['status'], string> = {
  running: '进行中',
  done: '完成',
  failed: '失败',
};

function fmtTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString('zh-CN', { hour12: false });
  } catch {
    return iso;
  }
}

export function RunEval({ profiles, onEvalDone }: Props) {
  // 表单状态（数字字段用 string 承载，避免输入时被 Number 截断）
  const [selected, setSelected] = useState<string[]>(() => profiles.map((p) => p.run_id));
  const [limit, setLimit] = useState('');
  const [runs, setRuns] = useState('3');
  const [judge, setJudge] = useState(true);
  const [budget, setBudget] = useState('100');
  const [concurrency, setConcurrency] = useState('4');
  const [dryRun, setDryRun] = useState(false);

  const [job, setJob] = useState<EvalJob | null>(null);
  const [history, setHistory] = useState<EvalJob[]>([]);
  const [startError, setStartError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  /** SSE 不可用时降级为轮询 */
  const [usePoll, setUsePoll] = useState(false);

  const pollTimerRef = useRef<number | null>(null);
  const doneNotifiedRef = useRef(false);
  const logRef = useRef<HTMLPreElement | null>(null);
  const onEvalDoneRef = useRef(onEvalDone);
  onEvalDoneRef.current = onEvalDone;

  const stopPoll = useCallback(() => {
    if (pollTimerRef.current !== null) {
      window.clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  const notifyDone = useCallback(() => {
    if (!doneNotifiedRef.current) {
      doneNotifiedRef.current = true;
      onEvalDoneRef.current();
    }
  }, []);

  const refreshHistory = useCallback(() => {
    api
      .evalJobs()
      .then((res) => setHistory(res.jobs))
      .catch(() => {
        /* ignore */
      });
  }, []);

  /* 轮询兜底：SSE 连不上时使用 */
  const poll = useCallback(() => {
    api
      .evalStatus()
      .then((res) => {
        setJob(res.job);
        const j = res.job;
        if (j && j.status === 'running') {
          pollTimerRef.current = window.setTimeout(poll, 1500);
        } else if (j && j.status === 'done') {
          notifyDone();
          refreshHistory();
        } else if (j && j.status === 'failed') {
          refreshHistory();
        }
      })
      .catch(() => {
        pollTimerRef.current = window.setTimeout(poll, 3000);
      });
  }, [notifyDone, refreshHistory]);

  /* 挂载：建立 SSE 连接（实时进度），失败则降级轮询 */
  useEffect(() => {
    const es = new EventSource('/api/eval/stream');

    onEvent<{ job: EvalJob | null }>(es, 'snapshot', ({ job: snap }) => {
      setJob(snap);
      if (snap && snap.status === 'running') {
        stopPoll(); // SSE 恢复后停掉兜底轮询
      }
    });
    onEvent<{ progress: EvalProgress }>(es, 'progress', ({ progress }) => {
      setJob((prev) => (prev ? { ...prev, status: 'running', progress } : prev));
    });
    onEvent<{ line: string }>(es, 'log', ({ line }) => {
      setJob((prev) => (prev ? { ...prev, logs: [...prev.logs, line] } : prev));
    });
    onEvent<{ summary: EvalSummary }>(es, 'done', ({ summary }) => {
      setJob((prev) =>
        prev ? { ...prev, status: 'done', summary, finishedAt: new Date().toISOString() } : prev,
      );
      notifyDone();
      refreshHistory();
    });
    onEvent<{ error: string; errorCode: string }>(es, 'failed', ({ error, errorCode }) => {
      setJob((prev) =>
        prev ? { ...prev, status: 'failed', error, errorCode, finishedAt: new Date().toISOString() } : prev,
      );
      refreshHistory();
    });
    es.onopen = () => setUsePoll(false);
    es.onerror = () => {
      setUsePoll(true);
      // SSE 断开且当前有任务在跑时，用轮询兜底
      setJob((prev) => {
        if (prev && prev.status === 'running' && pollTimerRef.current === null) {
          pollTimerRef.current = window.setTimeout(poll, 1500);
        }
        return prev;
      });
    };

    refreshHistory();

    return () => {
      es.close();
      stopPoll();
    };
  }, [poll, stopPoll, notifyDone, refreshHistory]);

  // 日志自动滚到底
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [job?.logs]);

  const start = async () => {
    if (selected.length === 0) {
      setStartError('请至少选择一个评测档位。');
      return;
    }
    setStarting(true);
    setStartError(null);
    doneNotifiedRef.current = false;
    stopPoll();

    const req = {
      profiles: selected.length === profiles.length ? null : selected,
      limit: limit.trim() === '' ? null : Number(limit),
      runs: Number(runs),
      judge,
      budget: Number(budget),
      concurrency: Number(concurrency),
      dryRun,
    };
    try {
      const res = await api.startEval(req);
      setJob(res.job);
      if (res.job.status === 'running') {
        refreshHistory();
        // SSE 正常时事件会自动推送；若已降级为轮询，这里启动轮询
        if (usePoll) {
          pollTimerRef.current = window.setTimeout(poll, 1200);
        }
      }
    } catch (e) {
      setStartError(e instanceof Error ? e.message : String(e));
    } finally {
      setStarting(false);
    }
  };

  const running = job?.status === 'running';
  const progress = job?.progress;

  return (
    <div className="eval-view">
      {/* 参数表单 */}
      <div className="section">
        <div className="section-head">
          <h2>运行评测</h2>
          <p className="dim">
            在 Web 端触发一次真实评测跑批（后台执行、可刷新页面）。会真实调用模型、产生费用，请先确认参数与预算。
          </p>
        </div>

        <div className="eval-form">
          <div className="eval-field">
            <label className="eval-label">评测档位（生成侧）</label>
            <div className="profile-check">
              {profiles.map((p) => (
                <label key={p.run_id} className="check-item">
                  <input
                    type="checkbox"
                    checked={selected.includes(p.run_id)}
                    onChange={(e) =>
                      setSelected((prev) =>
                        e.target.checked ? [...prev, p.run_id] : prev.filter((x) => x !== p.run_id),
                      )
                    }
                    disabled={running}
                  />
                  <code>{p.run_id}</code>
                  <span className="dim">{p.model_label}</span>
                </label>
              ))}
            </div>
          </div>

          <div className="eval-grid">
            <div className="eval-field">
              <label className="eval-label">case 数量（limit）</label>
              <input
                type="number"
                min="1"
                value={limit}
                onChange={(e) => setLimit(e.target.value)}
                placeholder="全部"
                disabled={running}
              />
              <span className="eval-hint">留空 = 全部 24 组</span>
            </div>
            <div className="eval-field">
              <label className="eval-label">每档重复（runs）</label>
              <input
                type="number"
                min="1"
                value={runs}
                onChange={(e) => setRuns(e.target.value)}
                disabled={running}
              />
              <span className="eval-hint">≥2 才能算 pass^k</span>
            </div>
            <div className="eval-field">
              <label className="eval-label">预算上限（元）</label>
              <input
                type="number"
                min="0"
                step="0.1"
                value={budget}
                onChange={(e) => setBudget(e.target.value)}
                disabled={running}
              />
              <span className="eval-hint">硬上限，超线即停</span>
            </div>
            <div className="eval-field">
              <label className="eval-label">并发数</label>
              <input
                type="number"
                min="1"
                value={concurrency}
                onChange={(e) => setConcurrency(e.target.value)}
                disabled={running}
              />
            </div>
          </div>

          <div className="eval-flags">
            <label className="check-item">
              <input type="checkbox" checked={judge} onChange={(e) => setJudge(e.target.checked)} disabled={running} />
              <span>跑 LLM 裁判（可执行性分，需换族模型）</span>
            </label>
            <label className="check-item">
              <input type="checkbox" checked={dryRun} onChange={(e) => setDryRun(e.target.checked)} disabled={running} />
              <span className="dim">仅预览 prompt（dry-run，不发请求、不花钱）</span>
            </label>
          </div>

          <div className="eval-actions">
            <button className="btn-primary" onClick={start} disabled={starting || running}>
              {starting ? '启动中…' : dryRun ? '预览 prompt' : '开始评测'}
            </button>
            {running && <span className="dim">评测进行中，可切到其它 tab 或刷新页面，任务不中断。</span>}
            {!running && !dryRun && (
              <span className="dim small">预计费用取决于档位与规模；硅基流动全矩阵约 ¥2.3。</span>
            )}
          </div>
        </div>

        {startError && <div className="error-card">{startError}</div>}
      </div>

      {/* 状态区 */}
      {job && (
        <div className="section">
          {job.status === 'running' && (
            <div className="eval-progress">
              <div className="eval-progress-head">
                <span className="eval-status-dot" />
                <span>评测进行中{usePoll ? '（轮询模式）' : ''}</span>
                {progress && (
                  <span className="dim">
                    {progress.phase === 'generating' ? '生成阶段' : '裁判阶段'} · {progress.completed}/{progress.total} · 已花
                    ¥{progress.spentCny.toFixed(2)} · 剩余 ¥{progress.remainingCny.toFixed(2)}
                    {progress.hasFailure ? ' · 有失败' : ''}
                  </span>
                )}
              </div>
              {progress && (
                <div className="progress-track">
                  <div
                    className="progress-bar"
                    style={{ width: `${Math.min(100, (progress.completed / Math.max(1, progress.total)) * 100)}%` }}
                  />
                </div>
              )}
            </div>
          )}

          {job.status === 'done' && job.summary && (
            <div className="eval-summary">
              <h3 className="eval-summary-title">评测完成</h3>
              <div className="eval-summary-grid">
                <div className="stat-mini">
                  <b>{job.summary.totalRuns}</b> 次运行
                </div>
                <div className="stat-mini">
                  <b>¥{job.summary.spentCny.toFixed(2)}</b> 本次新花
                </div>
                <div className="stat-mini">
                  <b>¥{(job.summary.genCostTotal + job.summary.judgeCostTotal).toFixed(2)}</b> 累计成本
                </div>
                <div className="stat-mini warn">
                  <b>{job.summary.noOutput}</b> 次无产出
                </div>
                <div className="stat-mini warn">
                  <b>{job.summary.failures}</b> 次失败
                </div>
                <div className="stat-mini">
                  <b>{(job.summary.durationMs / 1000).toFixed(1)}s</b> 耗时
                </div>
              </div>
              {job.summary.reportPath && (
                <p className="dim small" style={{ marginBottom: 0 }}>
                  报告：<code>{job.summary.reportPath}</code>（榜单 / 对比 / case 详情已刷新）
                </p>
              )}
            </div>
          )}

          {job.status === 'failed' && (
            <div className="error-card">
              <strong>评测失败</strong>：{job.error}
              {job.errorCode === 'missing_key' && (
                <div className="small dim">请在项目根目录的 .env 配置对应 API Key 后重试。</div>
              )}
            </div>
          )}

          {job.logs.length > 0 && (
            <details className="eval-log-details">
              <summary>运行日志（{job.logs.length} 行）</summary>
              <pre className="eval-log" ref={logRef}>
                {job.logs.join('\n')}
              </pre>
            </details>
          )}
        </div>
      )}

      {/* 历史评测 */}
      {history.length > 0 && (
        <div className="section">
          <div className="section-head">
            <h3>历史评测</h3>
            <p className="dim">最近 {history.length} 次（保存在内存中，服务重启后清空）</p>
          </div>
          <div className="history-list">
            {history.map((h) => (
              <div key={h.id} className={`history-item history-${h.status}`}>
                <span className="history-status">{STATUS_TEXT[h.status]}</span>
                <code className="history-id">{h.id}</code>
                <span className="dim">{fmtTime(h.startedAt)}</span>
                {h.summary && (
                  <span className="history-stat">
                    ¥{h.summary.spentCny.toFixed(2)} · {h.summary.totalRuns} 次 · {(h.summary.durationMs / 1000).toFixed(0)}s
                  </span>
                )}
                {h.status === 'failed' && <span className="warn small">{(h.errorCode ?? '').toUpperCase()}</span>}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
