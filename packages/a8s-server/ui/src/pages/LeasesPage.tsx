import { Table, Card } from '@arco-design/web-react';
import { useLeases } from '../api/queries.js';
import { PageHeader, ErrorBanner, Spinner, EmptyState } from '../components/Page.js';
import { StatusPill, relativeTime } from '../components/StatusPill.js';

export function LeasesPage() {
  const leases = useLeases();

  if (leases.error) return <ErrorBanner error={leases.error} />;
  if (!leases.data) return <Spinner />;

  const columns = [
    { title: 'Lease', dataIndex: 'leaseId', render: (v: string) => <code className="font-mono text-xs">{v.slice(0, 16)}</code> },
    { title: 'Agent', dataIndex: 'agentId', render: (v: string) => <code className="font-mono text-xs">{v}</code> },
    {
      title: 'Worker',
      dataIndex: 'workerId',
      render: (v: string | null) => <code className="font-mono text-xs" style={{ color: 'var(--color-text-3)' }}>{v ?? '—'}</code>,
    },
    { title: 'State', dataIndex: 'state', render: (v: string) => <StatusPill state={leaseState(v)} /> },
    { title: 'Acquired', dataIndex: 'acquiredAt', render: (v: number) => <span className="text-xs" style={{ color: 'var(--color-text-3)' }}>{relativeTime(v)}</span> },
    { title: 'Expires', dataIndex: 'expiresAt', render: (v: number) => <span className="text-xs" style={{ color: 'var(--color-text-3)' }}>{relativeTime(v)}</span> },
  ];

  return (
    <div className="animate-fade-in">
      <PageHeader
        title="Leases"
        subtitle={`${leases.data.length} runtime lease(s) · auto-refresh 10s`}
      />

      {leases.data.length === 0 ? (
        <EmptyState
          icon="📄"
          title="没有 lease"
          hint="agent 挂在某个 worker 上时会持有一个 lease。当前没有活跃的。"
        />
      ) : (
        <Card bordered bodyStyle={{ padding: 0 }}>
          <Table rowKey="leaseId" columns={columns} data={leases.data} pagination={false} size="small" />
        </Card>
      )}
    </div>
  );
}

// Map lease state → the WorkerState palette StatusPill understands.
function leaseState(state: string): string {
  if (state === 'active') return 'active';
  if (state === 'expired') return 'evicted';
  return 'withdrawn';
}
