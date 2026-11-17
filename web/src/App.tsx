import { useCallback, useEffect, useState } from 'react';
import { api } from './api';
import type { LeaderboardResponse, MetaResponse } from './types';
import { Leaderboard } from './components/Leaderboard';
import { CompareView } from './components/CompareView';
import { CaseDetail } from './components/CaseDetail';
import { RunEval } from './components/RunEval';
import { Tag } from './components/Badge';

type Tab = 'leaderboard' | 'compare' | 'case' | 'eval';

export default function App() {
  const [meta, setMeta] = useState<MetaResponse | null>(null);
  const [leaderboard, setLeaderboard] = useState<LeaderboardResponse | null>(null);
  const [tab, setTab] = useState<Tab>('leaderboard');
  const [error, setError] = useState<string | null>(null);

  const loadData = useCallback(() => {
    Promise.all([api.meta(), api.leaderboard()])
      .then(([m, l]) => {
        setMeta(m);
        setLeaderboard(l);
        setError(null);
      })
      .catch((e) => {
        setError(e instanceof Error ? e.message : String(e));
      });
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  return (
    <div className="app">
      <header className="app-header">
        <div className="brand">
          <h1>OfferLens</h1>
          <span className="brand-sub">求职 Agent 评测 · 回归控制台</span>
        </div>
        {meta && (
          <div className="header-meta">
            <Tag tone="neutral">{meta.caseCount} 组评测集</Tag>
            <Tag tone="neutral">种子 {meta.dataset.seed}</Tag>
            {meta.judge && <Tag tone="warn">裁判 {meta.judge.label}</Tag>}
          </div>
        )}
      </header>

      <nav className="tabs">
        <button className={tab === 'leaderboard' ? 'tab active' : 'tab'} onClick={() => setTab('leaderboard')}>
          模型榜单
        </button>
        <button className={tab === 'compare' ? 'tab active' : 'tab'} onClick={() => setTab('compare')}>
          对比分析
        </button>
        <button className={tab === 'case' ? 'tab active' : 'tab'} onClick={() => setTab('case')}>
          Case 详情
        </button>
        <button className={tab === 'eval' ? 'tab active' : 'tab'} onClick={() => setTab('eval')}>
          运行评测
        </button>
      </nav>

      {error && (
        <div className="error-card">
          加载失败：{error}
          <div className="small dim">
            请确认后端已启动（<code>npm run serve</code>）。开发模式可用 <code>npm run web:dev</code> 自动代理。
          </div>
        </div>
      )}

      {!error && meta && meta.dataSource === 'demo' && (
        <div className="warn-card">
          ⚠️ 当前展示的是 <strong>合成演示数据</strong>（data/real 为空时自动回退）。
          接入真实模型后运行 <code>npm run eval</code>，控制台会自动切到真实结果。
        </div>
      )}

      {!error && meta && tab === 'leaderboard' && (
        <main className="main">
          <section className="section">
            <div className="section-head">
              <h2>模型榜单</h2>
              <p className="dim">
                每个档位（模型 × prompt）的聚合表现。数值列可点表头排序；带 ↓ 的指标越低越好。
              </p>
            </div>
            {leaderboard ? (
              <Leaderboard rows={leaderboard.leaderboard} />
            ) : (
              <div className="empty-card">加载中…</div>
            )}
            {leaderboard?.judge && (
              <p className="footnote">
                可执行性由跨族裁判 {leaderboard.judge.label} 打分，正反序位置偏见不一致率{' '}
                {(leaderboard.judge.disagreement_rate * 100).toFixed(1)}% —— 该维度结论需打折。
              </p>
            )}
          </section>
        </main>
      )}

      {!error && meta && tab === 'compare' && (
        <main className="main">
          <section className="section">
            <div className="section-head">
              <h2>对比分析</h2>
              <p className="dim">选一对档位，看「这次改动到底有没有变好」，以及「哪个子集偷偷退化了」。</p>
            </div>
            <CompareView profiles={meta.profiles} />
          </section>
        </main>
      )}

      {!error && meta && tab === 'case' && (
        <main className="main">
          <section className="section">
            <div className="section-head">
              <h2>Case 详情 &amp; trace 瀑布图</h2>
              <p className="dim">
                从一个聚合数字钻到单条 case：看模型读到了什么、产出了什么、4 步里哪一步最烧 token / 最耗时。
              </p>
            </div>
            <CaseDetail profiles={meta.profiles} />
          </section>
        </main>
      )}

      {!error && meta && tab === 'eval' && (
        <main className="main">
          <RunEval profiles={meta.profiles} readonly={meta.readonly ?? false} onEvalDone={loadData} />
        </main>
      )}

      <footer className="app-footer">
        <span>OfferLens · 把「换了模型/改了 prompt 之后有没有变好」变成可复现、可统计检验的结论</span>
        {meta && <span className="dim">生成于 {new Date(meta.generatedAt).toLocaleString('zh-CN')}</span>}
      </footer>
    </div>
  );
}
