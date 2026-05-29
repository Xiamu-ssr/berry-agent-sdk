import type { ReactNode } from 'react';

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="flex items-end justify-between mb-6 pb-3 border-b border-ink-200 dark:border-ink-800">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {subtitle && <p className="text-sm text-ink-500 dark:text-ink-400 mt-1">{subtitle}</p>}
      </div>
      {actions && <div className="flex gap-2">{actions}</div>}
    </div>
  );
}

export function EmptyState({ icon, title, hint }: { icon: string; title: string; hint?: string }) {
  return (
    <div className="card text-center py-12">
      <div className="text-4xl mb-2">{icon}</div>
      <div className="font-medium text-ink-700 dark:text-ink-200">{title}</div>
      {hint && <div className="text-sm text-ink-500 dark:text-ink-400 mt-1">{hint}</div>}
    </div>
  );
}

export function ErrorBanner({ error }: { error: unknown }) {
  const msg = error instanceof Error ? error.message : String(error);
  return (
    <div className="card border-berry-300 dark:border-berry-900 bg-berry-50 dark:bg-berry-950/30 text-berry-700 dark:text-berry-300 text-sm">
      <strong className="font-semibold">Error:</strong> {msg}
    </div>
  );
}

export function Spinner() {
  return (
    <div className="flex items-center gap-2 text-sm text-ink-500 dark:text-ink-400">
      <div className="w-3 h-3 border-2 border-ink-300 border-t-berry-500 rounded-full animate-spin" />
      Loading…
    </div>
  );
}
