import { useEffect, useState } from 'react';
import { api } from '../api';
import type { JdView } from '../types';
import { Tag } from './Badge';

/**
 * JD 库 —— 回答「你的样本够不够、来自哪里」。
 *
 * 这是控制台里唯一一个不以「跑分」为主的标签，存在的理由是：
 * 榜单上的每个数字，其适用范围都由样本决定。一个 `business/senior` 只有 0 条的档位，
 * 和 `app/junior` 并列展示时，读者会以为「各档位都有结论」——实际那一档什么都没测过。
 *
 * 所以这一页刻意做两件事：
 *  1. 把缺口标红，而不是让空格看起来像 0 分。
 *  2. 合成与真实**分两行**统计，绝不合并成一个均值。
 */
export function JdLibrary() {
  const [data, setData] = useState<JdView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .jds()
      .then(setData)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  if (error) return <div className="error-card">JD 库加载失败：{error}</div>;
  if (!data) return <div className="empty-card">加载中…</div>;

  const { coverage, labels } = data;
  const syn = coverage.bySource.synthetic;
  const real = coverage.bySource.real;
  const lenRatio = syn.avgRawLength === 0 ? null : real.avgRawLength / syn.avgRawLength;

  return (
    <div className="jd-view">
      <div className="jd-summary">
        <div className="jd-stat">
          <span className="jd-stat-num">{data.total}</span>
          <span className="jd-stat-label">JD 总数</span>
        </div>
        <div className="jd-stat">
          <span className="jd-stat-num">{syn.count}</span>
          <span className="jd-stat-label">合成（手写样本）</span>
        </div>
        <div className="jd-stat">
          <span className="jd-stat-num">{real.count}</span>
          <span className="jd-stat-label">真实在招岗位</span>
        </div>
        <div className="jd-stat">
          <span className="jd-stat-num">{lenRatio === null ? '—' : `${lenRatio.toFixed(2)}×`}</span>
          <span className="jd-stat-label">真实 / 合成 原文长度比</span>
        </div>
      </div>

      <h3>覆盖矩阵</h3>
      <p className="dim small">
        行是岗位类别，列是经验档位。<strong>标红的格子是 0 条</strong> —— 那一档不能出结论，
        也不该和别的档位并列展示。
      </p>
      <div className="table-wrap">
        <table className="data-table matrix-table">
          <thead>
            <tr>
              <th>岗位类别</th>
              {labels.levelOrder.map((l) => (
                <th key={l} className="num">
                  {labels.levels[l]}
                </th>
              ))}
              <th className="num">合计</th>
            </tr>
          </thead>
          <tbody>
            {labels.categoryOrder.map((cat) => {
              const row = labels.levelOrder.map((l) => coverage.matrix[cat][l]);
              const sum = row.reduce((a, b) => a + b, 0);
              return (
                <tr key={cat}>
                  <td>
                    {labels.categories[cat]} <span className="dim small">{cat}</span>
                  </td>
                  {row.map((n, i) => (
                    <td key={i} className={`num ${n === 0 ? 'cell-gap' : ''}`}>
                      {n === 0 ? '缺' : n}
                    </td>
                  ))}
                  <td className="num dim">{sum}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="footnote">
        {coverage.gaps.length === 0
          ? '覆盖矩阵无缺口：每个类别 × 档位都有样本。'
          : `缺口 ${coverage.gaps.length} 格：${coverage.gaps.map((g) => `${g.category}/${g.level}`).join('、')}`}
      </p>

      <h3>按来源分组（刻意不合并统计）</h3>
      <p className="dim small">
        合成 JD 的门槛是手写的、措辞规整，门槛命中率天然偏乐观；真实 JD 有套话、福利条款和与岗位名不符的要求。
        把两者混进一个均值，等于用好看的数掩盖「真实场景更差」。
      </p>
      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>来源</th>
              <th className="num">条数</th>
              <th className="num">原文均长</th>
              <th className="num">hard_req 均</th>
              <th className="num">soft_req 均</th>
              <th>数据质量</th>
            </tr>
          </thead>
          <tbody>
            <SourceRow label="合成" tag="neutral" s={syn} />
            <SourceRow label="真实" tag="accent" s={real} />
          </tbody>
        </table>
      </div>

      <h3>全部 JD</h3>
      <p className="dim small">
        真实样本排在前面。采集方式与原文链接逐条列出 ——「真实」如果无法回溯到来源，就只是一句自我声明。
      </p>
      <div className="table-wrap">
        <table className="data-table jd-table">
          <thead>
            <tr>
              <th>岗位</th>
              <th>类别 / 档位</th>
              <th>公司类型</th>
              <th className="num">原文长度</th>
              <th className="num">门槛</th>
              <th>来源</th>
            </tr>
          </thead>
          <tbody>
            {data.items.map((it) => (
              <tr key={it.id}>
                <td>
                  <div className="jd-title">{it.title}</div>
                  <div className="dim small">{it.id}</div>
                  <div className="jd-excerpt">{it.excerpt}</div>
                </td>
                <td className="dim">
                  {labels.categories[it.category]} / {labels.levels[it.level]}
                </td>
                <td className="dim">{it.company_type}</td>
                <td className="num">{it.raw_length}</td>
                <td className="num">{it.hard_req.length}</td>
                <td>
                  {it.source === 'real' ? (
                    <>
                      <Tag tone="accent">真实</Tag>{' '}
                      {it.source_url ? (
                        <a className="jd-link" href={it.source_url} target="_blank" rel="noreferrer noopener">
                          {it.provenance === 'search-curated' ? '检索整理' : '人工粘贴'}
                        </a>
                      ) : (
                        <span className="dim small">缺来源链接</span>
                      )}
                      {it.collected_at && (
                        <div className="dim small">采集于 {it.collected_at.slice(0, 10)}</div>
                      )}
                    </>
                  ) : (
                    <Tag tone="neutral">合成</Tag>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function SourceRow({
  label,
  tag,
  s,
}: {
  label: string;
  tag: 'neutral' | 'accent';
  s: {
    count: number;
    avgRawLength: number;
    avgHardReq: number;
    avgSoftReq: number;
    hardReqEmpty: number;
    missingHash: number;
    missingProvenance: number;
  };
}) {
  const warns: string[] = [];
  if (s.hardReqEmpty > 0) warns.push(`${s.hardReqEmpty} 条门槛为空（gate 指标会恒为 0）`);
  if (s.missingHash > 0) warns.push(`${s.missingHash} 条缺指纹（无法去重）`);
  if (s.missingProvenance > 0) warns.push(`${s.missingProvenance} 条缺来源标注（无法回溯）`);

  return (
    <tr>
      <td>
        <Tag tone={tag}>{label}</Tag>
      </td>
      <td className="num">{s.count}</td>
      <td className="num">{s.avgRawLength}</td>
      <td className="num">{s.avgHardReq}</td>
      <td className="num">{s.avgSoftReq}</td>
      <td className={warns.length > 0 ? 'warn-text' : 'dim small'}>
        {s.count === 0 ? '—' : warns.length > 0 ? `⚠ ${warns.join('；')}` : '无异常'}
      </td>
    </tr>
  );
}
