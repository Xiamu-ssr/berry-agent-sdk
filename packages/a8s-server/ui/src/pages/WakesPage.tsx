import { Table, Card, Button, Popconfirm, Message } from '@arco-design/web-react';
import { useWakes, useCancelWake } from '../api/queries.js';
import { PageHeader, ErrorBanner, Spinner, EmptyState } from '../components/Page.js';
import { WakeStatePill, relativeTime } from '../components/StatusPill.js';

export function WakesPage() {
  const wakes = useWakes();
  const cancel = useCancelWake();

  if (wakes.error) return <ErrorBanner error={wakes.error} />;
  if (!wakes.data) return <Spinner />;

  const columns = [
    { title: 'Wake', dataIndex: 'wakeId', render: (v: string) => <code className="font-mono text-xs">{v.slice(0, 16)}</code> },
    { title: 'Agent', dataIndex: 'agentId', render: (v: string) => <code className="font-mono text-xs">{v}</code> },
    { title: 'Reason', dataIndex: 'reason' },
    { title: 'State', dataIndex: 'state', render: (v: string) => <WakeStatePill state={v} /> },
    { title: 'Due', dataIndex: 'dueAt', render: (v: number) => <span className="text-xs" style={{ color: 'var(--color-text-3)' }}>{relativeTime(v)}</span> },
    {
      title: '',
      dataIndex: '__actions',
      width: 90,
      align: 'right' as const,
      render: (_: unknown, w: { wakeId: string; state: string }) =>
        w.state === 'pending' ? (
          <Popconfirm
            title={`取消 wake ${w.wakeId.slice(0, 12)}…?`}
            okText="取消该 wake"
            cancelText="返回"
            onOk={() => { cancel.mutate(w.wakeId); Message.success('已取消'); }}
          >
            <Button size="mini">取消</Button>
          </Popconfirm>
        ) : null,
    },
  ];

  return (
    <div className="animate-fade-in">
      <PageHeader title="Wake queue" subtitle={`${wakes.data.length} scheduled · auto-refresh 5s`} />

      {wakes.data.length === 0 ? (
        <EmptyState icon="⏰" title="没有排期的 wake" hint="产品调用 POST /v1/wakes/schedule 时会触发 wake。" />
      ) : (
        <Card bordered bodyStyle={{ padding: 0 }}>
          <Table rowKey="wakeId" columns={columns} data={wakes.data} pagination={false} size="small" />
        </Card>
      )}
    </div>
  );
}
