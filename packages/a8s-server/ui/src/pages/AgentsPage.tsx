import { useMemo, useState } from 'react';
import {
  Table, Button, Modal, Form, Input, Select, Tag, Popconfirm, Message, Card, Spin,
} from '@arco-design/web-react';
import {
  useAgents,
  useSessions,
  useDeleteAgent,
  useAgentSkills,
  useRemoveAgentSkill,
  useAgentSnapshot,
} from '../api/queries.js';
import { PageHeader, ErrorBanner, Spinner, EmptyState } from '../components/Page.js';
import { relativeTime } from '../components/StatusPill.js';
import { EventStream } from '../components/EventStream.js';
import { OctopusView } from '../components/OctopusView.js';
import { OctopusWizard } from '../components/OctopusWizard.js';

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
        <OctopusWizard
          existingIds={new Set(agents.data.map((a) => a.agentId))}
          onClose={() => setShowCreate(false)}
        />
      )}
    </div>
  );
}

// ============================================================

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
  const snapshot = useAgentSnapshot(agentId);

  return (
    <div className="space-y-4">
      {/* Octopus visualization */}
      {snapshot.data && (
        <Card bordered title={<span className="text-sm font-semibold uppercase tracking-wider">{agentId}</span>}>
          <div className="flex justify-center">
            <OctopusView
              data={{
                brain: { model: snapshot.data.model, provider: snapshot.data.provider, status: snapshot.data.status },
                hands: snapshot.data.hands,
                skills: snapshot.data.skills,
              }}
              size={320}
            />
          </div>
        </Card>
      )}

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
