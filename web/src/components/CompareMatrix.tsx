import type { CompareCell } from '../types';
import { metricOf } from '../metrics';
import { SigBadge } from './Badge';

/**
 * 对比矩阵 —— 一行一个指标，标出基线 → 候选的变化方向与显著性。
 * 这是整个项目最想讲出来的东西：「不显著」不等于没变化，每个格子都要能看出来。
 */
export function CompareMatrix({ cells, baseLabel, candLabel }: { cells: CompareCell[]; baseLabel: string; candLabel: string }) {
  return (
    <div className="table-wrap">
      <table className="data-table">
        <thead>
          <tr>
            <th>指标</th>
            <th className="num">基线</th>
            <th className="num">候选</th>
            <th className="num">变化</th>
            <th>显著性</th>
            <th>检验方法</th>
            <th className="num">配对样本</th>
          </tr>
        </thead>
        <tbody>
          {cells.map((c) => {
            const meta = metricOf(c.metric);
            const deltaStr = `${c.delta >= 0 ? '+' : ''}${meta.format(Math.abs(c.delta))}${c.delta < 0 ? '' : ''}`;
            return (
              <tr key={c.metric}>
                <td>
                  <div className="metric-label">{c.label}</div>
                  <div className="dim small">{meta.higherIsBetter ? '越高越好' : '越低越好'}</div>
                </td>
                <td className="num">{meta.format(c.base)}</td>
                <td className="num">{meta.format(c.cand)}</td>
                <td className={`num delta delta-${c.direction}`}>
                  {c.direction === 'better' ? '↑' : c.direction === 'worse' ? '↓' : '·'} {deltaStr}
                </td>
                <td>
                  <SigBadge direction={c.direction} significant={c.significant} text={c.badge} />
                </td>
                <td className="dim small">
                  {c.method === 'mcnemar' && c.mcnemar ? (
                    <>McNemar p={c.mcnemar.p.toFixed(4)}</>
                  ) : c.ci ? (
                    <>95% CI [{c.ci.lo.toFixed(3)}, {c.ci.hi.toFixed(3)}]</>
                  ) : (
                    '—'
                  )}
                </td>
                <td className="num dim">{c.n}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="footnote">
        基线 <code>{baseLabel}</code> · 候选 <code>{candLabel}</code>。「不显著」只说明差异在配对检验下还站不住，不等于没有差异。
      </p>
    </div>
  );
}
