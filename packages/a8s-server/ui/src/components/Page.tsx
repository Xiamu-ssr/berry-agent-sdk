import type { ReactNode } from 'react';
import { Spin, Empty, Alert } from '@arco-design/web-react';

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
    <div
      className="flex items-end justify-between mb-6 pb-3"
      style={{ borderBottom: '1px solid var(--color-border-2)' }}
    >
      <div>
        <h1 className="text-2xl font-semibold tracking-tight" style={{ color: 'var(--color-text-1)' }}>{title}</h1>
        {subtitle && <p className="text-sm mt-1" style={{ color: 'var(--color-text-3)' }}>{subtitle}</p>}
      </div>
      {actions && <div className="flex gap-2">{actions}</div>}
    </div>
  );
}

export function EmptyState({ icon, title, hint }: { icon: string; title: string; hint?: string }) {
  return (
    <Empty
      icon={<span className="text-4xl">{icon}</span>}
      description={
        <div>
          <div className="font-medium" style={{ color: 'var(--color-text-1)' }}>{title}</div>
          {hint && <div className="text-sm mt-1" style={{ color: 'var(--color-text-3)' }}>{hint}</div>}
        </div>
      }
      style={{ padding: '3rem 0' }}
    />
  );
}

export function ErrorBanner({ error }: { error: unknown }) {
  const msg = error instanceof Error ? error.message : String(error);
  return <Alert type="error" title="Error" content={msg} />;
}

export function Spinner() {
  return <Spin tip="Loading…" style={{ display: 'block', padding: '2rem 0', textAlign: 'center' }} />;
}
