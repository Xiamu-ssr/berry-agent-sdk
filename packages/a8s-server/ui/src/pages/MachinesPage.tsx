import { useState } from 'react';
import { Table, Card, Button, Modal, Message, Typography } from '@arco-design/web-react';
import { useMachines, useMachineJoinScript, type Machine } from '../api/queries.js';
import { PageHeader, ErrorBanner, Spinner, EmptyState } from '../components/Page.js';
import { StatusPill, relativeTime } from '../components/StatusPill.js';

export function MachinesPage() {
  const machines = useMachines();
  const joinScript = useMachineJoinScript();
  const [scriptModal, setScriptModal] = useState<string | null>(null);

  if (machines.error) return <ErrorBanner error={machines.error} />;
  if (!machines.data) return <Spinner />;

  const columns = [
    { title: 'Machine', dataIndex: 'machineId', render: (v: string) => <code className="font-mono text-xs">{v}</code> },
    { title: 'State', dataIndex: 'state', render: (v: Machine['state']) => <StatusPill state={machineState(v)} /> },
    {
      title: 'Platform',
      dataIndex: 'platform',
      render: (v: string | undefined) => <span className="text-xs" style={{ color: 'var(--color-text-3)' }}>{v ?? '—'}</span>,
    },
    {
      title: 'MCP',
      dataIndex: '__mcp',
      render: (_: unknown, m: Machine) => (
        <span className="text-xs" style={{ color: 'var(--color-text-3)' }}>
          {m.mcpServers.length > 0
            ? `${m.mcpServers.join(', ')} (${m.mcpToolCount} tool${m.mcpToolCount === 1 ? '' : 's'})`
            : '—'}
        </span>
      ),
    },
    { title: 'Heartbeat', dataIndex: 'heartbeatAt', render: (v: number) => <span className="text-xs" style={{ color: 'var(--color-text-3)' }}>{relativeTime(v)}</span> },
  ];

  return (
    <div className="animate-fade-in">
      <PageHeader
        title="Machines"
        subtitle={`${machines.data.length} registered · auto-refresh 5s`}
        actions={
          <Button
            type="primary"
            loading={joinScript.isPending}
            onClick={async () => {
              const res = await joinScript.mutateAsync({});
              setScriptModal(res.script);
            }}
          >
            添加机器
          </Button>
        }
      />

      <Typography.Paragraph type="secondary" className="-mt-3 mb-4 max-w-3xl text-sm">
        机器向集群出借一个执行面 —— 被授权的 agent(在创建 agent 时通过
        <code className="font-mono text-xs mx-1">machines</code> 标签)会得到
        <code className="font-mono text-xs mx-1">machine_&lt;id&gt;_exec</code> 工具在它上面跑命令。
        与 worker 不同,机器不跑 agent brain。用「添加机器」在主机上装连接器。
      </Typography.Paragraph>

      {machines.data.length === 0 ? (
        <EmptyState
          icon="🖐"
          title="还没有注册的机器"
          hint="点「添加机器」,在你想让 agent 操作的主机上运行脚本(例如在它上面装一个 worker)。"
        />
      ) : (
        <Card bordered bodyStyle={{ padding: 0 }}>
          <Table rowKey="machineId" columns={columns} data={machines.data} pagination={false} size="small" />
        </Card>
      )}

      {scriptModal && <JoinScriptModal script={scriptModal} onClose={() => setScriptModal(null)} />}
    </div>
  );
}

// Map machine state → the WorkerState palette StatusPill understands.
function machineState(state: Machine['state']): string {
  if (state === 'active') return 'active';
  if (state === 'expired') return 'draining';
  return 'withdrawn';
}

function JoinScriptModal({ script, onClose }: { script: string; onClose: () => void }) {
  return (
    <Modal
      visible
      title="Machine 连接器安装脚本"
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
        在你要添加的主机上运行。
        <strong style={{ color: 'rgb(var(--red-6))' }}>它包含集群 admin token —— 切勿公开分享。</strong>
        {' '}机器会注册并接受集群下发的命令,所以只在你打算让 agent 操作的主机上安装。
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
