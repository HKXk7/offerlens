import { useEffect, useMemo, useState } from 'react';
import type { CompareResult, ProfileMeta } from '../types';
import { api } from '../api';
import { CompareMatrix } from './CompareMatrix';
import { SliceDrilldown } from './SliceDrilldown';
import { Tag } from './Badge';

/**
 * 对比视图：选基线 + 候选 → 拉取对比矩阵 + 切片下钻。
 * 默认选硅基流动矩阵里的前两个档位（跨厂商对比，信息量最大）。
 */
export function CompareView({ profiles }: { profiles: ProfileMeta[] }) {
  const [base, setBase] = useState('');
  const [cand, setCand] = useState('');
  const [data, setData] = useState<CompareResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 默认：基线选第一个，候选选第二个（跨厂商矩阵前两个档位）
  useEffect(() => {
    if (profiles.length === 0) return;
    const sf = profiles.filter((p) => p.platform.startsWith('硅基流动'));
    const pool = sf.length >= 2 ? sf : profiles;
    if (!base) setBase(pool[0]?.run_id ?? '');
    if (!cand) setCand(pool[1]?.run_id ?? pool[0]?.run_id ?? '');
  }, [profiles, base, cand]);

  useEffect(() => {
    if (!base || !cand) return;
    if (base === cand) {
      setData(null);
      setError('基线与候选不能是同一个档位');
      return;
    }
    let alive = true;
    setLoading(true);
    setError(null);
    api
      .compare(base, cand)
      .then((d) => {
        if (alive) setData(d);
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
  }, [base, cand]);

  const promptLabel = useMemo(() => {
    const b = profiles.find((p) => p.run_id === base);
    const c = profiles.find((p) => p.run_id === cand);
    return { b, c };
  }, [profiles, base, cand]);

  return (
    <div className="compare-view">
      <div className="selector-bar">
        <label>
          基线
          <select value={base} onChange={(e) => setBase(e.target.value)}>
            {profiles.map((p) => (
              <option key={p.run_id} value={p.run_id}>
                {p.model_label} · {p.prompt_version}
              </option>
            ))}
          </select>
        </label>
        <span className="vs">vs</span>
        <label>
          候选
          <select value={cand} onChange={(e) => setCand(e.target.value)}>
            {profiles.map((p) => (
              <option key={p.run_id} value={p.run_id}>
                {p.model_label} · {p.prompt_version}
              </option>
            ))}
          </select>
        </label>
        <div className="selector-meta">
          {promptLabel.b && <Tag tone="accent">{promptLabel.b.platform}</Tag>}
          {promptLabel.c && <Tag tone="accent">{promptLabel.c.platform}</Tag>}
        </div>
      </div>

      {loading && <div className="empty-card">正在计算对比矩阵…</div>}
      {error && <div className="error-card">{error}</div>}

      {data && !loading && (
        <>
          {data.crossPlatform && (
            <div className="warn-card">
              ⚠️ 基线（{data.base.platform}）与候选（{data.cand.platform}）不在同一平台 ——
              第三方转发站与原厂的后端、量化不同，数字不可直接混比，请谨慎解读。
            </div>
          )}
          <CompareMatrix cells={data.matrix.cells} baseLabel={data.base.run_id} candLabel={data.cand.run_id} />
          <SliceDrilldown
            quality={data.slice.quality}
            resource={data.slice.resource}
            resourceCollapsed={data.slice.resourceCollapsed}
          />
        </>
      )}
    </div>
  );
}
