import type { SliceFinding } from '../types';
import { metricOf, sliceValueLabel, SLICE_LABEL } from '../metrics';
import { SigBadge } from './Badge';

/**
 * 切片下钻 —— 回答「整体持平，但某个子集是不是偷偷退化了」。
 * 能力类指标全保留；资源类（成本/延迟）折叠到只剩最值得看的几条。
 */
export function SliceDrilldown({
  quality,
  resource,
  resourceCollapsed,
}: {
  quality: SliceFinding[];
  resource: SliceFinding[];
  resourceCollapsed: number;
}) {
  const empty = quality.length === 0 && resource.length === 0;

  if (empty) {
    return (
      <div className="empty-card">
        没有任何切片上的差异达到显著 —— 整体结论在子集上同样成立。
      </div>
    );
  }

  return (
    <div className="slice">
      <h3>切片下钻</h3>
      <p className="dim small">
        同一个改动，整体可能看不出差别，但某个岗位类别 / 某类简历上会显著退化。这就是平台存在的理由。
      </p>

      {quality.length > 0 ? (
        <div className="slice-group">
          <h4>能力类指标（全部保留）</h4>
          <SliceTable findings={quality} />
        </div>
      ) : (
        <div className="slice-group">
          <h4>能力类指标</h4>
          <div className="empty-card">无显著的能力差异。</div>
        </div>
      )}

      {resource.length > 0 && (
        <div className="slice-group">
          <h4>资源类指标（成本 / 延迟，只留最值得看的）</h4>
          <SliceTable findings={resource} />
          {resourceCollapsed > 0 && (
            <p className="dim small">
              另有 {resourceCollapsed} 条资源类差异与上表方向一致（整体成本/延迟差异在每个切片上的复读），已折叠。
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function SliceTable({ findings }: { findings: SliceFinding[] }) {
  return (
    <div className="table-wrap">
      <table className="data-table">
        <thead>
          <tr>
            <th>切片维度</th>
            <th>取值</th>
            <th>指标</th>
            <th className="num">基线</th>
            <th className="num">候选</th>
            <th>显著性</th>
            <th className="num">样本</th>
          </tr>
        </thead>
        <tbody>
          {findings.map((f, i) => {
            const meta = metricOf(f.cell.metric);
            return (
              <tr key={`${f.slice_key}-${f.slice_value}-${f.cell.metric}-${i}`}>
                <td className="dim">{SLICE_LABEL[f.slice_key] ?? f.slice_key}</td>
                <td>{sliceValueLabel(f.slice_key, f.slice_value)}</td>
                <td>{f.cell.label}</td>
                <td className="num">{meta.format(f.cell.base)}</td>
                <td className="num">{meta.format(f.cell.cand)}</td>
                <td>
                  <SigBadge direction={f.cell.direction} significant={f.cell.significant} text={f.cell.badge} />
                </td>
                <td className="num dim">{f.n}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
