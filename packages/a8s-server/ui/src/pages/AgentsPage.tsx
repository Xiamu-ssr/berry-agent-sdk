import { useMemo, useState } from 'react';
import {
  Table, Button, Modal, Form, Input, Select, Tag, Popconfirm, Message, Card, Spin,
} from '@arco-design/web-react';
import {
  useAgents,
  useSessions,
  useDeleteAgent,
  useCreateAgent,
  useModelsTemplate,
  useWorkers,
  useMachines,
  useHandRecipes,
  useAgentSkills,
  useRemoveAgentSkill,
  type HandRecipe,
} from '../api/queries.js';
import { PageHeader, ErrorBanner, Spinner, EmptyState } from '../components/Page.js';
import { relativeTime } from '../components/StatusPill.js';
import { EventStream } from '../components/EventStream.js';

export function AgentsPage() {
  const agents = useAgents();
  const del = useDeleteAgent();
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const [selectedSession, setSelectedSession] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const sessions = useSessions(selectedAgent);

  if (agents.error) return <ErrorBanner error={agents.error} />;
  if (!agents.data) return <Spinner />;

  const columns = [
    {
      title: 'Agent',
      dataIndex: 'agentId',
      render: (id: string) => <code className="font-mono text-xs">{id}</code>,
    },
    {
      title: 'Worker',
      dataIndex: 'workerId',
      render: (workerId: string | null) =>
        workerId
          ? <code className="font-mono text-xs" style={{ color: 'var(--color-text-3)' }}>{workerId}</code>
          : <Tag color="red" size="small">stranded</Tag>,
    },
    {
      title: '',
      dataIndex: '__actions',
      width: 90,
      align: 'right' as const,
      render: (_: unknown, a: { agentId: string }) => (
        <Popconfirm
          title={`删除 agent「${a.agentId}」?`}
          content="这会停止运行时;磁盘上的数据会保留。"
          okText="删除"
          cancelText="取消"
          onOk={() => {
            del.mutate(a.agentId);
            if (selectedAgent === a.agentId) setSelectedAgent(null);
            Message.success(`已删除 ${a.agentId}`);
          }}
        >
          <Button type="text" status="danger" size="mini" onClick={(e) => e.stopPropagation()}>删除</Button>
        </Popconfirm>
      ),
    },
  ];

  return (
    <div className="animate-fade-in">
      <PageHeader
        title="Agents"
        subtitle={`${agents.data.length} assigned · auto-refresh 5s`}
        actions={<Button type="primary" onClick={() => setShowCreate(true)}>创建 agent</Button>}
      />

      {agents.data.length === 0 ? (
        <EmptyState
          icon="◊"
          title="还没有运行中的 agent"
          hint='点「创建 agent」在集群上挂一个,或通过产品代码 / Admin chat 创建。'
        />
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-[1fr_2fr] gap-4">
          <Card bordered bodyStyle={{ padding: 0 }}>
            <Table
              rowKey="agentId"
              columns={columns}
              data={agents.data}
              pagination={false}
              size="small"
              rowClassName={(a: { agentId: string }) => (selectedAgent === a.agentId ? 'arco-table-row-selected-soft' : '')}
              onRow={(a: { agentId: string }) => ({
                onClick: () => { setSelectedAgent(a.agentId); setSelectedSession(null); },
                style: { cursor: 'pointer' },
              })}
            />
          </Card>

          <div>
            {selectedAgent ? (
              <AgentDetail
                agentId={selectedAgent}
                selectedSession={selectedSession}
                onSelectSession={setSelectedSession}
                sessions={sessions.data ?? []}
                sessionsLoading={sessions.isLoading}
              />
            ) : (
              <EmptyState icon="◊" title="选择一个 agent" hint="点一行查看它的 session 和实时事件。" />
            )}
          </div>
        </div>
      )}

      {showCreate && (
        <CreateAgentModal
          existingIds={new Set(agents.data.map((a) => a.agentId))}
          onClose={() => setShowCreate(false)}
        />
      )}
    </div>
  );
}

// ============================================================
// Create-agent modal
// ============================================================
// Mirrors the wire spec a8s POST /v1/agents accepts. Model choices come from
// the operator-configured models template (the same one workers pull at
// register), so we never let the operator type a model id no worker can serve.
//
// Hands (甲1): selecting a Hand = granting its reference — we union each chosen
// Hand's bound machineId into labels.machines (the agent then gets
// machine_<id>_exec + reaches its MCP via berry-mcp). Landing the Hand's
// .mcp.json onto the machine stays a separate operator step (Hand market).

function CreateAgentModal({
  existingIds,
  onClose,
}: {
  existingIds: Set<string>;
  onClose: () => void;
}) {
  const template = useModelsTemplate();
  const workers = useWorkers();
  const machines = useMachines();
  const recipes = useHandRecipes();
  const create = useCreateAgent();

  const [agentId, setAgentId] = useState('');
  const [model, setModel] = useState('');
  const [preferredMachine, setPreferredMachine] = useState('');
  const [selectedHands, setSelectedHands] = useState<string[]>([]);
  const [grantedMachines, setGrantedMachines] = useState<string[]>([]);

  const modelOptions = useMemo(() => {
    if (!template.data?.template) return { tiers: [] as string[], models: [] as string[] };
    const t = template.data.template;
    return {
      tiers: Object.keys(t.tiers ?? {}).map((k) => `tier:${k}`),
      models: Object.keys(t.models ?? {}),
    };
  }, [template.data]);

  const machineOptions = useMemo(() => {
    const set = new Set<string>();
    (workers.data ?? []).forEach((w) => {
      const m = w.labels?.machine;
      if (m) set.add(m);
    });
    return Array.from(set).sort();
  }, [workers.data]);

  const activeMachines = (machines.data ?? []).filter((m) => m.state === 'active').map((m) => m.machineId);
  // Only Hands bound to a machine can be selected here (a grant needs a machine).
  const selectableHands = (recipes.data ?? []).filter((r): r is HandRecipe & { machineId: string } => !!r.machineId);

  // The effective machine grant = machines from chosen Hands ∪ raw grants.
  const handMachines = selectedHands
    .map((id) => selectableHands.find((r) => r.id === id)?.machineId)
    .filter((m): m is string => !!m);
  const effectiveMachines = Array.from(new Set([...handMachines, ...grantedMachines]));

  const idValid = /^[a-zA-Z0-9._-]{1,64}$/.test(agentId);
  const idCollides = existingIds.has(agentId);
  const canSubmit = idValid && !idCollides && model.length > 0 && !create.isPending;

  const noTemplate = template.data && !template.data.template;
  const noWorkers = workers.data && workers.data.filter((w) => w.state === 'active').length === 0;

  const submit = () => {
    if (!canSubmit) return;
    create.mutate(
      {
        agentId: agentId.trim(),
        model: model.trim(),
        preferredMachine: preferredMachine.trim() || undefined,
        labels: effectiveMachines.length > 0 ? { machines: effectiveMachines.join(',') } : undefined,
      },
      {
        onSuccess: () => { Message.success(`已创建 ${agentId.trim()}`); onClose(); },
      },
    );
  };

  return (
    <Modal
      visible
      title="创建 agent"
      onCancel={onClose}
      style={{ width: 560 }}
      footer={
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>取消</Button>
          <Button type="primary" loading={create.isPending} disabled={!canSubmit} onClick={submit}>创建</Button>
        </div>
      }
    >
      {template.isLoading || workers.isLoading ? (
        <Spin />
      ) : noTemplate ? (
        <div className="text-sm" style={{ color: 'rgb(var(--red-6))' }}>
          还没有配置 models 模板。先打开 <strong>Models</strong> 页配置 provider + 模型,worker 才知道用什么。
        </div>
      ) : noWorkers ? (
        <div className="text-sm" style={{ color: 'rgb(var(--red-6))' }}>
          没有活跃 worker。在 <strong>Workers</strong> 页生成 join 脚本并至少加一个 worker,再创建 agent。
        </div>
      ) : (
        <Form layout="vertical">
          <Form.Item
            label="Agent ID"
            extra="作为 /var/berry/agents 下的目录名。字母、数字、点、横线、下划线,最多 64 字符。"
            validateStatus={agentId.length > 0 && (!idValid || idCollides) ? 'error' : undefined}
            help={
              agentId.length > 0 && !idValid ? '只能用字母、数字、点、横线、下划线(最多 64)。'
              : idCollides ? '已存在同名 agent。' : undefined
            }
          >
            <Input value={agentId} onChange={setAgentId} placeholder="e.g. helper-1" autoFocus />
          </Form.Item>

          <Form.Item label="模型" extra="从集群级 models 模板里选。">
            <Select value={model} onChange={setModel} placeholder="选一个模型…">
              {modelOptions.tiers.length > 0 && (
                <Select.OptGroup label="Tiers(推荐)">
                  {modelOptions.tiers.map((t) => <Select.Option key={t} value={t}>{t}</Select.Option>)}
                </Select.OptGroup>
              )}
              {modelOptions.models.length > 0 && (
                <Select.OptGroup label="Models">
                  {modelOptions.models.map((m) => <Select.Option key={m} value={m}>{m}</Select.Option>)}
                </Select.OptGroup>
              )}
            </Select>
          </Form.Item>

          <Form.Item
            label="选择 Hand"
            extra="勾选一个 Hand = 把它绑定的机器授权给这个 agent(得到 machine exec + 经 berry-mcp 触达其 MCP)。落地 .mcp.json 是独立的运维步。"
          >
            {selectableHands.length === 0 ? (
              <div className="text-xs" style={{ color: 'var(--color-text-3)' }}>
                没有绑定机器的 Hand。去「Hand 市场」创建,或在下方直接授权机器。
              </div>
            ) : (
              <div className="flex flex-wrap gap-2">
                {selectableHands.map((r) => {
                  const on = selectedHands.includes(r.id);
                  return (
                    <Tag
                      key={r.id}
                      checkable
                      checked={on}
                      color={on ? 'arcoblue' : undefined}
                      onCheck={(checked: boolean) =>
                        setSelectedHands((prev) => (checked ? [...prev, r.id] : prev.filter((x) => x !== r.id)))
                      }
                    >
                      {r.name} <span style={{ opacity: 0.6 }}>· {r.machineId}</span>
                    </Tag>
                  );
                })}
              </div>
            )}
          </Form.Item>

          <Form.Item
            label="授权机器(高级)"
            extra="可选。直接把机器授权给 agent(machine_<id>_exec),不经 Hand。"
          >
            {activeMachines.length === 0 ? (
              <div className="text-xs" style={{ color: 'var(--color-text-3)' }}>没有活跃机器。在 Machines 页添加一台。</div>
            ) : (
              <div className="flex flex-wrap gap-2">
                {activeMachines.map((m) => {
                  const fromHand = handMachines.includes(m);
                  const on = grantedMachines.includes(m) || fromHand;
                  return (
                    <Tag
                      key={m}
                      checkable
                      checked={on}
                      color={on ? 'green' : undefined}
                      // A machine pulled in by a selected Hand is locked on.
                      onCheck={(checked: boolean) => {
                        if (fromHand) return;
                        setGrantedMachines((prev) => (checked ? [...prev, m] : prev.filter((x) => x !== m)));
                      }}
                    >
                      {m}{fromHand ? ' (来自 Hand)' : ''}
                    </Tag>
                  );
                })}
              </div>
            )}
          </Form.Item>

          <Form.Item
            label="首选机器"
            extra="可选。调度器优先尝试这台机器;否则回退默认策略。"
          >
            <Select value={preferredMachine} onChange={setPreferredMachine} placeholder="(任意)" allowClear>
              {machineOptions.map((m) => <Select.Option key={m} value={m}>{m}</Select.Option>)}
            </Select>
          </Form.Item>

          {create.error && <ErrorBanner error={create.error} />}
        </Form>
      )}
    </Modal>
  );
}

function AgentDetail({
  agentId,
  selectedSession,
  onSelectSession,
  sessions,
  sessionsLoading,
}: {
  agentId: string;
  selectedSession: string | null;
  onSelectSession(id: string | null): void;
  sessions: import('../api/queries.js').SessionSummary[];
  sessionsLoading: boolean;
}) {
  return (
    <div className="space-y-4">
      <Card bordered title={<span className="text-sm font-semibold uppercase tracking-wider">Sessions</span>}>
        {sessionsLoading ? (
          <Spinner />
        ) : sessions.length === 0 ? (
          <div className="text-sm" style={{ color: 'var(--color-text-3)' }}>还没有 session。</div>
        ) : (
          <ul className="space-y-1">
            {sessions.map((s) => (
              <li key={s.id}>
                <button
                  className="w-full text-left text-sm px-3 py-2 rounded-md transition-colors"
                  style={selectedSession === s.id
                    ? { background: 'var(--color-fill-2)', color: 'var(--color-text-1)' }
                    : { color: 'var(--color-text-2)' }}
                  onClick={() => onSelectSession(s.id)}
                >
                  <div className="flex items-center justify-between">
                    <code className="font-mono text-xs">{s.id}</code>
                    <Tag size="small">{s.status}</Tag>
                  </div>
                  <div className="text-xs mt-0.5" style={{ color: 'var(--color-text-3)' }}>
                    {relativeTime(s.lastActiveAt)} · {s.messageCount ?? 0} messages
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <AgentSkillsCard agentId={agentId} />

      {selectedSession && (
        <Card bordered title={<span className="text-sm font-semibold uppercase tracking-wider">Events (live)</span>}>
          <EventStream agentId={agentId} sessionId={selectedSession} />
        </Card>
      )}
    </div>
  );
}

// ============================================================
// Agent skills — what this agent has installed (home is source of truth)
// ============================================================
// Install happens from the Skill market (pick an agent there). Here we show the
// agent's currently-installed skills and allow removing one.

function AgentSkillsCard({ agentId }: { agentId: string }) {
  const skills = useAgentSkills(agentId);
  const remove = useRemoveAgentSkill();
  return (
    <Card bordered title={<span className="text-sm font-semibold uppercase tracking-wider">Skills</span>}>
      {skills.isLoading ? (
        <Spinner />
      ) : !skills.data || skills.data.length === 0 ? (
        <div className="text-sm" style={{ color: 'var(--color-text-3)' }}>
          没有已安装技能。去「Skill 市场」选一个装到这个 agent 上。
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          {skills.data.map((name) => (
            <Popconfirm
              key={name}
              title={`从 ${agentId} 移除技能「${name}」?`}
              okText="移除"
              cancelText="取消"
              onOk={() => remove.mutate({ agentId, name })}
            >
              <Tag color="arcoblue" closable onClose={(e) => e?.preventDefault?.()}>
                <code className="font-mono">{name}</code>
              </Tag>
            </Popconfirm>
          ))}
        </div>
      )}
    </Card>
  );
}
