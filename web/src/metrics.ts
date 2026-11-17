// 指标格式化与展示元信息 —— 前端唯一要知道「哪个指标高好、怎么显示」的地方。

export type MetricKey =
  | 'pass_rate'
  | 'exec_score'
  | 'unsourced_rate'
  | 'anchor_coverage'
  | 'avg_cost'
  | 'p95_latency';

export interface MetricMeta {
  key: MetricKey;
  label: string;
  higherIsBetter: boolean;
  format: (v: number) => string;
}

const pct = (v: number) => `${(v * 100).toFixed(1)}%`;

export const METRICS: Record<MetricKey, MetricMeta> = {
  pass_rate: { key: 'pass_rate', label: '达标率', higherIsBetter: true, format: pct },
  exec_score: {
    key: 'exec_score',
    label: '可执行性(1-3)',
    higherIsBetter: true,
    format: (v) => v.toFixed(2),
  },
  unsourced_rate: { key: 'unsourced_rate', label: '无源实体率', higherIsBetter: false, format: pct },
  anchor_coverage: { key: 'anchor_coverage', label: '锚点覆盖', higherIsBetter: true, format: pct },
  avg_cost: { key: 'avg_cost', label: '单次成本', higherIsBetter: false, format: (v) => `¥${v.toFixed(4)}` },
  p95_latency: {
    key: 'p95_latency',
    label: 'P95 延迟',
    higherIsBetter: false,
    format: (v) => `${Math.round(v / 1000)}s`,
  },
};

export const METRIC_ORDER: MetricKey[] = [
  'pass_rate',
  'unsourced_rate',
  'exec_score',
  'anchor_coverage',
  'avg_cost',
  'p95_latency',
];

export function metricOf(key: string): MetricMeta {
  return METRICS[key as MetricKey] ?? { key: key as MetricKey, label: key, higherIsBetter: true, format: (v) => v.toFixed(3) };
}

export const SLICE_LABEL: Record<string, string> = {
  category: '岗位类别',
  experience_level: '简历经历',
  level: '岗位级别',
};

export const CATEGORY_LABEL: Record<string, string> = {
  app: 'AI 应用前端',
  platform: 'AI 平台前端',
  data: '数据平台',
  business: '普通业务前端',
};

export const EXPERIENCE_LABEL: Record<string, string> = {
  rich: '经历丰富',
  thin: '经历单薄',
  career_change: '转行',
  incomplete: '字段残缺',
};

export const LEVEL_LABEL: Record<string, string> = {
  intern: '实习',
  junior: '初级',
  senior: '高级',
};

export function sliceValueLabel(sliceKey: string, value: string): string {
  if (sliceKey === 'category') return CATEGORY_LABEL[value] ?? value;
  if (sliceKey === 'experience_level') return EXPERIENCE_LABEL[value] ?? value;
  if (sliceKey === 'level') return LEVEL_LABEL[value] ?? value;
  return value;
}
