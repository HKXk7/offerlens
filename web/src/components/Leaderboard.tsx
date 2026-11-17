import { useMemo, useState } from 'react';
import {
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
} from '@tanstack/react-table';
import type { LeaderboardRow } from '../types';
import { Tag } from './Badge';

/**
 * 模型榜单 —— 用 TanStack Table 做一个可排序的数据网格。
 * 每个数值列都能点表头排序；「达标率 / pass³ / 锚点覆盖」越高越好，
 * 「无源实体率 / 成本 / 延迟」越低越好（排序时按该语义取负号，这样「升序」永远=「更优」）。
 */

const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
const num = (v: number, d = 2) => v.toFixed(d);

interface Props {
  rows: LeaderboardRow[];
}

export function Leaderboard({ rows }: Props) {
  const [sorting, setSorting] = useState<SortingState>([{ id: 'pass_rate', desc: true }]);

  const columns = useMemo<ColumnDef<LeaderboardRow>[]>(
    () => [
      {
        id: 'config',
        header: '档位（模型 × prompt）',
        accessorFn: (r) => r.model_label,
        enableSorting: false,
        cell: ({ row }) => (
          <div className="config-cell">
            <div className="config-model">{row.original.model_label}</div>
            <div className="config-sub">
              <code>{row.original.run_id}</code>
            </div>
          </div>
        ),
      },
      {
        id: 'provider',
        header: '厂商',
        accessorFn: (r) => r.provider,
        cell: ({ row }) => <Tag tone="accent">{row.original.provider}</Tag>,
      },
      {
        id: 'prompt',
        header: 'Prompt',
        accessorFn: (r) => r.prompt_version,
        cell: ({ row }) => <code>{row.original.prompt_version}</code>,
      },
      {
        id: 'output_rate',
        header: '产出率',
        accessorFn: (r) => r.output_rate,
        cell: ({ row }) => {
          const r = row.original;
          return (
            <span title={`有产出 ${r.output_count} / 无产出 ${r.no_output_count}`}>
              {pct(r.output_rate)}
              {r.no_output_count > 0 && <span className="warn-mark"> ⚠{r.no_output_count}</span>}
            </span>
          );
        },
      },
      {
        id: 'unsourced_rate',
        header: '无源实体率 ↓',
        accessorFn: (r) => -r.unsourced_rate,
        cell: ({ row }) => num(row.original.unsourced_rate, 3),
      },
      {
        id: 'anchor_coverage',
        header: '锚点覆盖',
        accessorFn: (r) => r.anchor_coverage,
        cell: ({ row }) => pct(row.original.anchor_coverage),
      },
      {
        id: 'pass_rate',
        header: '达标率',
        accessorFn: (r) => r.pass_rate,
        cell: ({ row }) => <strong>{pct(row.original.pass_rate)}</strong>,
      },
      {
        id: 'pass_k',
        header: 'pass³',
        accessorFn: (r) => r.pass_k,
        cell: ({ row }) => pct(row.original.pass_k),
      },
      {
        id: 'exec_score',
        header: '可执行性',
        accessorFn: (r) => r.exec_score ?? -Infinity,
        cell: ({ row }) =>
          row.original.exec_score === null ? <span className="dim">—</span> : num(row.original.exec_score),
      },
      {
        id: 'avg_cost',
        header: '单次成本 ↓',
        accessorFn: (r) => -r.avg_cost_cny,
        cell: ({ row }) => `¥${num(row.original.avg_cost_cny, 4)}`,
      },
      {
        id: 'p95_latency',
        header: 'P95 延迟 ↓',
        accessorFn: (r) => -r.p95_latency_ms,
        cell: ({ row }) => `${Math.round(row.original.p95_latency_ms / 1000)}s`,
      },
      {
        id: 'stability',
        header: '稳定性',
        accessorFn: (r) => r.stability.flaky_rate,
        cell: ({ row }) => {
          const s = row.original.stability;
          return (
            <span className="dim" title={`全过 ${s.always} / 时好时坏 ${s.flaky} / 全挂 ${s.never}`}>
              {pct(s.flaky_rate)} 不稳
            </span>
          );
        },
      },
    ],
    [],
  );

  const table = useReactTable({
    data: rows,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  return (
    <div className="table-wrap">
      <table className="data-table">
        <thead>
          {table.getHeaderGroups().map((hg) => (
            <tr key={hg.id}>
              {hg.headers.map((h) => (
                <th key={h.id} className={h.column.getCanSort() ? 'sortable' : ''} onClick={h.column.getToggleSortingHandler()}>
                  <span className="th-inner">
                    {flexRender(h.column.columnDef.header, h.getContext())}
                    {h.column.getIsSorted() === 'asc' ? ' ▲' : h.column.getIsSorted() === 'desc' ? ' ▼' : ''}
                  </span>
                </th>
              ))}
            </tr>
          ))}
        </thead>
        <tbody>
          {table.getRowModel().rows.map((row) => (
            <tr key={row.id}>
              {row.getVisibleCells().map((cell) => (
                <td key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
