import type { ReactNode } from 'react';

export interface StatPillProps {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: 'default' | 'success' | 'warn' | 'danger';
}

const TONE_RING: Record<NonNullable<StatPillProps['tone']>, string> = {
  default: 'border-ink-200 dark:border-ink-800',
  success: 'border-emerald-200 dark:border-emerald-900',
  warn: 'border-amber-200 dark:border-amber-900',
  danger: 'border-berry-200 dark:border-berry-900',
};

export function StatCard({ label, value, hint, tone = 'default' }: StatPillProps) {
  return (
    <div className={`card border ${TONE_RING[tone]}`}>
      <div className="text-xs font-medium uppercase tracking-wider text-ink-500 dark:text-ink-400">
        {label}
      </div>
      <div className="mt-2 text-3xl font-semibold tabular-nums">{value}</div>
      {hint && <div className="mt-1 text-xs text-ink-500 dark:text-ink-500">{hint}</div>}
    </div>
  );
}
