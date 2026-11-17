import type { ReactNode } from 'react';

type Direction = 'better' | 'worse' | 'same';

/** 显著/方向角标。颜色语义：better=绿、worse=红、不显著/无变化=灰。 */
export function SigBadge({
  direction,
  significant,
  text,
}: {
  direction: Direction;
  significant: boolean;
  text?: string;
}) {
  const tone = !significant || direction === 'same' ? 'neutral' : direction === 'better' ? 'good' : 'bad';
  const label = text ?? (!significant ? '不显著' : direction === 'same' ? '无变化' : direction === 'better' ? '显著更好' : '显著更差');
  return <span className={`badge badge-${tone}`}>{label}</span>;
}

export function Tag({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'accent' | 'warn' }) {
  return <span className={`tag tag-${tone}`}>{children}</span>;
}
