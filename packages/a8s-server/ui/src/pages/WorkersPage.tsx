import { useState } from 'react';
import { Table, Card, Button, Modal, Popconfirm, Message } from '@arco-design/web-react';
import { useWorkers, useWorkerAction, useJoinScript } from '../api/queries.js';
import { PageHeader, ErrorBanner, Spinner, EmptyState } from '../components/Page.js';
import { StatusPill, relativeTime } from '../components/StatusPill.js';

export function WorkersPage() {
  const workers = useWorkers();
  const drain = useWorkerAction('drain');
  const undrain = useWorkerAction('undrain');
  const evict = useWorkerAction('evict');
  const joinScript = useJoinScript();
  const [scriptModal, setScriptModal] = useState<string | null>(null);

  if (workers.error) return <ErrorBanner error={workers.error} />;
  if (!workers.data) return <Spinner />;

  const columns = [
    { title: 'Worker', dataIndex: 'workerId', render: (v: string) => <code className="font-mono text-xs">{v}</code> },
    { title: 'State', dataIndex: 'state', render: (v: string) => <StatusPill state={v} /> },
    {
      title: 'Capacity',
      dataIndex: 'capacity',
      render: (_: number, w: { used: number; capacity: number }) => (
        <span className="tabular-nums">
          <span className="font-medium">{w.used}</span>
          <span className="mx-1" style={{ color: 'var(--color-text-4)' }}>/</span>
          {w.capacity}
        </span>
      ),
    },
    {
      title: 'Machine',
      dataIndex: '__machine',
      render: (_: unknown, w: { labels?: Record<string, string> }) => (
        <code className="font-mono text-xs" style={{ color: 'var(--color-text-3)' }}>{w.labels?.machine ?? '—'}</code>
      ),
    },
    { title: 'Heartbeat', dataIndex: 'heartbeatAt', render: (v: number) => <span className="text-xs" style={{ color: 'var(--color-text-3)' }}>{relativeTime(v)}</span> },
    {
      title: '',
      dataIndex: '__actions',
      align: 'right' as const,
      width: 180,
      render: (_: unknown, w: { workerId: string; state: string }) => (
        <div className="flex justify-end gap-1.5">
          {w.state === 'active' && <Button size="mini" onClick={() => drain.mutate(w.workerId)}>Drain</Button>}
          {w.state === 'draining' && <Button size="mini" onClick={() => undrain.mutate(w.workerId)}>Undrain</Button>}
          <Popconfirm
            title={`驱逐 ${w.workerId}?`}
            content="它上面的 agent 会被释放,需要重新调度。"
            okText="驱逐"
            cancelText="取消"
            onOk={() => { evict.mutate(w.workerId); Message.success(`已驱逐 ${w.workerId}`); }}
          >
            <Button size="mini" status="danger">Evict</Button>
          </Popconfirm>
        </div>
      ),
    },
  ];

  return (
    <div className="animate-fade-in">
      <PageHeader
        title="Workers"
        subtitle={`${workers.data.length} registered · auto-refresh 5s`}
        actions={
          <Button
            type="primary"
            loading={joinScript.isPending}
            onClick={async () => {
              const res = await joinScript.mutateAsync({});
              setScriptModal(res.script);
            }}
          >
            生成 join 脚本
          </Button>
        }
      />

      {workers.data.length === 0 ? (
        <EmptyState
          icon="◌"
          title="还没有注册的 worker"
          hint="点「生成 join 脚本」,在新主机上粘贴运行,即可添加算力。"
        />
      ) : (
        <Card bordered bodyStyle={{ padding: 0 }}>
          <Table rowKey="workerId" columns={columns} data={workers.data} pagination={false} size="small" />
        </Card>
      )}

      {scriptModal && <JoinScriptModal script={scriptModal} onClose={() => setScriptModal(null)} />}
    </div>
  );
}

function JoinScriptModal({ script, onClose }: { script: string; onClose: () => void }) {
  return (
    <Modal
      visible
      title="Worker join 脚本"
      onCancel={onClose}
      style={{ width: 760 }}
      footer={
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>关闭</Button>
          <Button
            type="primary"
            onClick={async () => { await navigator.clipboard.writeText(script); Message.success('已复制到剪贴板'); }}
          >
            复制到剪贴板
          </Button>
        </div>
      }
    >
      <p className="text-sm mb-3" style={{ color: 'var(--color-text-2)' }}>
        在新主机的 SSH 会话里粘贴运行。
        <strong style={{ color: 'rgb(var(--red-6))' }}>它包含集群 admin token —— 切勿公开分享。</strong>
      </p>
      <pre
        className="overflow-auto p-4 rounded-md text-xs font-mono whitespace-pre-wrap"
        style={{ maxHeight: '60vh', background: 'var(--color-fill-2)', color: 'var(--color-text-1)' }}
      >
        {script}
      </pre>
    </Modal>
  );
}
