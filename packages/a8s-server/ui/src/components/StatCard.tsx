import type { ReactNode } from 'react';
import { Card } from '@arco-design/web-react';

export interface StatPillProps {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: 'default' | 'success' | 'warn' | 'danger';
}

// Tone tints the left border so a card can flag attention without shouting.
const TONE_BORDER: Record<NonNullable<StatPillProps['tone']>, string> = {
  default: 'var(--color-border-2)',
  success: 'rgb(var(--green-6))',
  warn: 'rgb(var(--orange-6))',
  danger: 'rgb(var(--red-6))',
};

export function StatCard({ label, value, hint, tone = 'default' }: StatPillProps) {
  return (
    <Card
      bordered
      style={{ borderLeft: `3px solid ${TONE_BORDER[tone]}` }}
      bodyStyle={{ padding: '16px 18px' }}
    >
      <div className="text-xs font-medium uppercase tracking-wider" style={{ color: 'var(--color-text-3)' }}>
        {label}
      </div>
      <div className="mt-2 text-3xl font-semibold tabular-nums" style={{ color: 'var(--color-text-1)' }}>{value}</div>
      {hint && <div className="mt-1 text-xs" style={{ color: 'var(--color-text-3)' }}>{hint}</div>}
    </Card>
  );
}
