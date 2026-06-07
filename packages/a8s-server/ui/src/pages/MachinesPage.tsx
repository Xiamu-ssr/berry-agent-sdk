import { useState, useEffect } from 'react';
import { Table, Card, Button, Modal, Message, Typography, Input } from '@arco-design/web-react';
import {
  useMachines, useMachineJoinScript, useMachineMcpConfig, useSetMachineMcp,
  type Machine,
} from '../api/queries.js';
import { PageHeader, ErrorBanner, Spinner, EmptyState } from '../components/Page.js';
import { StatusPill, relativeTime } from '../components/StatusPill.js';

export function MachinesPage() {
  const machines = useMachines();
  const joinScript = useMachineJoinScript();
  const [scriptModal, setScriptModal] = useState<string | null>(null);
  const [mcpFor, setMcpFor] = useState<Machine | null>(null);

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
    {
      title: '',
      dataIndex: '__actions',
      width: 110,
      align: 'right' as const,
      render: (_: unknown, m: Machine) => (
        <Button size="mini" disabled={m.state !== 'active'} onClick={() => setMcpFor(m)}>设置 MCP</Button>
      ),
    },
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
        机器的 <code className="font-mono text-xs mx-1">.mcp.json</code> 是该机 MCP 能力的<strong>唯一事实源</strong>——用「设置 MCP」远程编辑;Hand 只引用这里暴露的 server 名。
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
      {mcpFor && <SetMcpModal machine={mcpFor} onClose={() => setMcpFor(null)} />}
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

// ============================================================
// 设置 MCP — remotely author the machine's .mcp.json (single source of truth)
// ============================================================
// Reads the machine's current mcpServers map, lets the operator edit it as raw
// JSON, then POSTs it back: a8s writes the file over the exec broker, runs any
// install commands, and reloads the connector. ${VAR} env refs stay as names —
// the value is the machine owner's asset, never collected here.

function SetMcpModal({ machine, onClose }: { machine: Machine; onClose: () => void }) {
  const current = useMachineMcpConfig(machine.machineId);
  const setMcp = useSetMachineMcp();
  const [json, setJson] = useState<string>('');
  const [installCmds, setInstallCmds] = useState('');
  const [jsonError, setJsonError] = useState<string | null>(null);

  // Pre-fill the editor once the current config loads.
  useEffect(() => {
    if (current.data) setJson(JSON.stringify(current.data.mcpServers ?? {}, null, 2));
  }, [current.data]);

  const submit = async () => {
    let mcpServers: Record<string, Record<string, unknown>>;
    try {
      const parsed = JSON.parse(json || '{}');
      const servers = parsed && typeof parsed === 'object' && 'mcpServers' in parsed ? parsed.mcpServers : parsed;
      if (!servers || typeof servers !== 'object' || Array.isArray(servers)) {
        throw new Error('应是一个对象:{ "server-name": { "command": … } }');
      }
      mcpServers = servers as Record<string, Record<string, unknown>>;
    } catch (e) {
      setJsonError(e instanceof Error ? e.message : String(e));
      return;
    }
    setJsonError(null);
    const installCommands = installCmds.split('\n').map((s) => s.trim()).filter(Boolean);
    const res = await setMcp.mutateAsync({ machineId: machine.machineId, mcpServers, installCommands });
    Message.success(`已写入 ${machine.machineId} 的 .mcp.json — 现有 server: ${res.mcpServers.join(', ') || '(无)'}`);
    onClose();
  };

  return (
    <Modal
      visible
      title={`设置「${machine.machineId}」的 MCP`}
      onCancel={onClose}
      style={{ width: 620 }}
      footer={
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>取消</Button>
          <Button type="primary" loading={setMcp.isPending} disabled={!current.data} onClick={submit}>写入并重载</Button>
        </div>
      }
    >
      <p className="text-sm mb-3" style={{ color: 'var(--color-text-2)' }}>
        编辑这台机器的 <code className="font-mono text-xs mx-1">.mcp.json</code> 的
        <code className="font-mono text-xs mx-1">mcpServers</code>。写入后 a8s 会让连接器重载,新能力随即生效。
        <code className="font-mono text-xs mx-1">{'${VAR}'}</code> 是机器本机的密钥引用,a8s 不收集其值。
      </p>

      {current.error ? (
        <ErrorBanner error={current.error} />
      ) : !current.data ? (
        <Spinner />
      ) : (
        <>
          <Input.TextArea
            className="font-mono"
            value={json}
            onChange={setJson}
            autoSize={{ minRows: 8, maxRows: 18 }}
            placeholder={'{\n  "playwright": { "command": "npx", "args": ["-y", "@playwright/mcp@latest", "--headless"] }\n}'}
          />
          {jsonError && <div className="text-xs mt-1" style={{ color: 'rgb(var(--red-6))' }}>JSON 解析失败:{jsonError}</div>}
          <label className="block mt-3">
            <span className="text-xs" style={{ color: 'var(--color-text-3)' }}>安装命令(可选,每行一条,写入前在机器上执行)</span>
            <Input.TextArea
              className="mt-1 font-mono"
              value={installCmds}
              onChange={setInstallCmds}
              autoSize={{ minRows: 2, maxRows: 6 }}
              placeholder={'npm i -g @playwright/mcp@latest'}
            />
          </label>
        </>
      )}

      {setMcp.error ? <div className="text-sm mt-2" style={{ color: 'rgb(var(--red-6))' }}>{setMcp.error instanceof Error ? setMcp.error.message : String(setMcp.error)}</div> : null}
    </Modal>
  );
}
