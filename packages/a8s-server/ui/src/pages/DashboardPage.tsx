import { useEffect, useMemo, useRef, useState } from 'react';
import { Button, Card, Checkbox, Tag } from '@arco-design/web-react';
import { IconCheck } from '@arco-design/web-react/icon';
import {
  useCluster, useWorkers, useAgents, useMachines,
  useAdminAgentStatus, useModelsTemplate, useEnsureAdminAgent,
} from '../api/queries.js';
import { EntityPickerField } from '../components/EntityPicker.js';
import { modelPickerConfig } from '../components/entityConfigs.js';
import { StatCard } from '../components/StatCard.js';
import { Sparkline } from '../components/Sparkline.js';
import { PageHeader, ErrorBanner, Spinner } from '../components/Page.js';

// ============================================================
// Dashboard — dual mode
// ============================================================
// Empty cluster → Step Guide (worker → machine → admin agent)
// Ready cluster → Stats overview (original dashboard)

export function DashboardPage() {
  const workers = useWorkers();
  const adminStatus = useAdminAgentStatus();

  const activeWorkers = workers.data?.filter((w) => w.state === 'active') ?? [];
  const showGuide = activeWorkers.length === 0 || !adminStatus.data?.present;

  if (showGuide) return <StepGuide />;
  return <DashboardStats />;
}

// ============================================================
// Step Guide — first-run experience
// ============================================================

function StepGuide() {
  const workers = useWorkers();
  const machines = useMachines();
  const adminStatus = useAdminAgentStatus();
  const template = useModelsTemplate();
  const ensure = useEnsureAdminAgent();

  const activeWorkers = workers.data?.filter((w) => w.state === 'active') ?? [];
  const activeMachines = machines.data?.filter((m) => m.state === 'active') ?? [];

  const step1Done = activeWorkers.length > 0;
  const step2Done = activeMachines.length > 0;
  const step3Done = adminStatus.data?.present === true;

  const templateReady = useMemo(
    () => !!template.data?.template && Object.keys(template.data.template.models ?? {}).length > 0,
    [template.data],
  );

  const [selectedMachines, setSelectedMachines] = useState<Set<string>>(new Set());
  const [model, setModel] = useState<string | null>(null);

  const toggleMachine = (id: string) => {
    setSelectedMachines((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleCreate = () => {
    ensure.mutate({
      ...(model ? { model } : {}),
      ...(selectedMachines.size > 0 ? { machines: [...selectedMachines].join(',') } : {}),
    });
  };

  return (
    <div className="space-y-6 animate-fade-in">
      <PageHeader
        title="集群初始化"
        subtitle="按步骤部署你的雪山引擎集群"
      />

      {/* Step 1: Worker */}
      <StepCard
        number={1}
        title="连接 Worker"
        done={step1Done}
        subtitle="Worker 是运行 agent 的算力节点。在目标机器上执行以下命令:"
      >
        {step1Done ? (
          <div className="space-y-2">
            {activeWorkers.map((w) => (
              <div key={w.workerId} className="flex items-center gap-2 text-sm">
                <Tag color="green" size="small">active</Tag>
                <code className="font-mono text-xs">{w.workerId}</code>
                <span style={{ color: 'var(--color-text-3)' }}>
                  {w.used}/{w.capacity} slots
                </span>
              </div>
            ))}
          </div>
        ) : (
          <div className="space-y-2">
            <pre className="text-xs p-3 rounded overflow-x-auto" style={{ background: 'var(--color-fill-2)', color: 'var(--color-text-2)' }}>
{`# 1. 安装 berry-worker (需要 Node.js 22+)
npm install -g @berry-agent/worker-daemon

# 2. 创建配置文件 /etc/berry/worker.json
# 3. 启动 worker
berry-worker start --config /etc/berry/worker.json`}
            </pre>
            <div className="text-xs" style={{ color: 'var(--color-text-3)' }}>
              详见 Workers 页面。Worker 启动后会自动注册到此集群。
            </div>
          </div>
        )}
      </StepCard>

      {/* Step 2: Machine */}
      <StepCard
        number={2}
        title="连接 Machine"
        done={step2Done}
        subtitle="Machine 是 agent 的执行环境(Hand)。在目标机器上部署 connector:"
      >
        {step2Done ? (
          <div className="space-y-2">
            {activeMachines.map((m) => (
              <div key={m.machineId} className="flex items-center gap-2 text-sm">
                <Tag color="green" size="small">active</Tag>
                <code className="font-mono text-xs">{m.machineId}</code>
                <span style={{ color: 'var(--color-text-3)' }}>{m.platform ?? 'unknown'}</span>
              </div>
            ))}
          </div>
        ) : (
          <div className="space-y-2">
            <pre className="text-xs p-3 rounded overflow-x-auto" style={{ background: 'var(--color-fill-2)', color: 'var(--color-text-2)' }}>
{`# 在目标机器上:
berry-machine start \\
  --a8s <a8s-url> \\
  --machine-id <machine-id> \\
  --port 7200`}
            </pre>
            <div className="text-xs" style={{ color: 'var(--color-text-3)' }}>
              详见 Machines 页面。Connector 启动后会自动注册。
            </div>
          </div>
        )}
      </StepCard>

      {/* Step 3: Admin Agent */}
      <StepCard
        number={3}
        title="创建 Admin Agent"
        done={step3Done}
        subtitle="berry-admin 是集群管理 agent,可执行运维操作(报告状态、部署 worker 等)。"
        disabled={!step1Done}
      >
        {step3Done ? (
          <div className="text-sm flex items-center gap-2">
            <Tag color="green" size="small">running</Tag>
            mounted on <code className="font-mono text-xs">{adminStatus.data?.workerId}</code>。
            前往 <strong>Admin Chat</strong> 页面与它对话。
          </div>
        ) : (
          <div className="space-y-3">
            {!templateReady && (
              <div className="text-xs" style={{ color: 'rgb(var(--red-6))' }}>
                先在 <strong>Models</strong> 页配置至少一个模型。
              </div>
            )}

            {/* Machine selection */}
            {activeMachines.length > 0 && (
              <div>
                <div className="text-xs mb-2" style={{ color: 'var(--color-text-3)' }}>选择要授权的 Machine(Hand）:</div>
                <div className="flex flex-wrap gap-3">
                  {activeMachines.map((m) => (
                    <Checkbox
                      key={m.machineId}
                      checked={selectedMachines.has(m.machineId)}
                      onChange={() => toggleMachine(m.machineId)}
                    >
                      <code className="font-mono text-xs">{m.machineId}</code>
                      <span className="text-xs ml-1" style={{ color: 'var(--color-text-3)' }}>({m.platform ?? '?'})</span>
                    </Checkbox>
                  ))}
                </div>
              </div>
            )}

            {/* Model selection */}
            <div className="max-w-xs">
              <div className="text-xs mb-1" style={{ color: 'var(--color-text-3)' }}>主模型(留空 = tier:strong)</div>
              <EntityPickerField
                config={modelPickerConfig}
                value={model}
                onChange={setModel}
                title="选择 admin 主模型"
                placeholder="默认 tier:strong…"
                clearable
              />
            </div>

            {ensure.error && <ErrorBanner error={ensure.error} />}
            <Button
              type="primary"
              loading={ensure.isPending}
              disabled={!step1Done || !templateReady}
              onClick={handleCreate}
            >
              一键创建 Admin Agent
            </Button>
          </div>
        )}
      </StepCard>
    </div>
  );
}

// ============================================================
// StepCard — a numbered step with done/pending state
// ============================================================

function StepCard({
  number, title, subtitle, done, disabled, children,
}: {
  number: number;
  title: string;
  subtitle: string;
  done: boolean;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Card
      bordered
      style={disabled ? { opacity: 0.5 } : undefined}
    >
      <div className="flex items-start gap-4">
        <div
          className="flex-none w-8 h-8 rounded-full flex items-center justify-center text-sm font-semibold"
          style={{
            background: done ? 'rgb(var(--green-6))' : 'var(--color-fill-3)',
            color: done ? '#fff' : 'var(--color-text-2)',
          }}
        >
          {done ? <IconCheck /> : number}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-sm font-semibold" style={{ color: 'var(--color-text-1)' }}>{title}</span>
            {done && <Tag color="green" size="small">完成</Tag>}
          </div>
          <div className="text-xs mb-3" style={{ color: 'var(--color-text-3)' }}>{subtitle}</div>
          {children}
        </div>
      </div>
    </Card>
  );
}

// ============================================================
// DashboardStats — the original dashboard (cluster is ready)
// ============================================================

const HISTORY_MAX = 30;

function DashboardStats() {
  const cluster = useCluster();
  const workers = useWorkers();
  const agents = useAgents();

  const [capHistory, setCapHistory] = useState<number[]>([]);
  const lastUpdate = useRef(0);
  useEffect(() => {
    const c = cluster.data;
    if (!c || cluster.dataUpdatedAt === lastUpdate.current) return;
    lastUpdate.current = cluster.dataUpdatedAt;
    const pct = c.capacity.total === 0 ? 0 : Math.round((c.capacity.used / c.capacity.total) * 100);
    setCapHistory((h) => [...h, pct].slice(-HISTORY_MAX));
  }, [cluster.data, cluster.dataUpdatedAt]);

  if (cluster.error) return <ErrorBanner error={cluster.error} />;
  if (!cluster.data) return <Spinner />;

  const c = cluster.data;
  const capacityPct = c.capacity.total === 0 ? 0 : Math.round((c.capacity.used / c.capacity.total) * 100);
  const activeWorkers = workers.data?.filter((w) => w.state === 'active') ?? [];
  const recentAgents = agents.data?.slice(0, 5) ?? [];

  return (
    <div className="space-y-6 animate-fade-in">
      <PageHeader
        title="Cluster overview"
        subtitle={`up ${formatUptime(c.uptimeSeconds)} · auto-refresh 5s`}
      />

      <Card bordered>
        <div className="flex items-start justify-between gap-6">
          <div>
            <div className="text-sm font-semibold uppercase tracking-wider" style={{ color: 'var(--color-text-3)' }}>Capacity used</div>
            <div className="mt-1 text-4xl font-semibold tabular-nums" style={{ color: 'var(--color-text-1)' }}>
              {capacityPct}<span className="text-2xl" style={{ color: 'var(--color-text-4)' }}>%</span>
            </div>
            <div className="mt-1 text-sm" style={{ color: 'var(--color-text-3)' }}>
              {c.capacity.used} of {c.capacity.total} slots · {c.capacity.available} available
            </div>
          </div>
          <Sparkline
            data={capHistory}
            width={280}
            height={64}
            tone={capacityPct > 80 ? 'berry' : 'snow'}
            className="mt-1"
          />
        </div>
      </Card>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          label="Active workers"
          value={c.workerCount.active}
          hint={`${c.workerCount.total} total · ${c.workerCount.draining} draining`}
          tone={c.workerCount.active === 0 ? 'warn' : 'success'}
        />
        <StatCard label="Agents" value={c.agentCount} hint="assigned to workers" />
        <StatCard
          label="Available slots"
          value={c.capacity.available}
          tone={c.capacity.available === 0 ? 'danger' : 'default'}
        />
        <StatCard label="Total capacity" value={c.capacity.total} hint={`${c.capacity.used} in use`} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card bordered title={<span className="text-sm font-semibold uppercase tracking-wider">Worker pool</span>}>
          {activeWorkers.length === 0 ? (
            <div className="text-sm" style={{ color: 'var(--color-text-3)' }}>没有活跃 worker —— agent 无法被调度。</div>
          ) : (
            <ul className="space-y-2">
              {activeWorkers.map((w) => {
                const pct = w.capacity === 0 ? 0 : Math.round((w.used / w.capacity) * 100);
                return (
                  <li key={w.workerId} className="text-sm">
                    <div className="flex items-center justify-between">
                      <span className="font-mono" style={{ color: 'var(--color-text-2)' }}>{w.workerId}</span>
                      <span className="tabular-nums" style={{ color: 'var(--color-text-3)' }}>{w.used} / {w.capacity}</span>
                    </div>
                    <div className="mt-1 h-1.5 rounded-full overflow-hidden" style={{ background: 'var(--color-fill-2)' }}>
                      <div
                        className="h-full rounded-full"
                        style={{ width: `${pct}%`, background: pct > 80 ? 'rgb(var(--red-5))' : 'rgb(var(--arcoblue-6))' }}
                      />
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        <Card bordered title={<span className="text-sm font-semibold uppercase tracking-wider">Latest agents</span>}>
          {recentAgents.length === 0 ? (
            <div className="text-sm" style={{ color: 'var(--color-text-3)' }}>还没有 agent。</div>
          ) : (
            <ul className="space-y-2">
              {recentAgents.map((a) => (
                <li key={a.agentId} className="flex items-center justify-between text-sm">
                  <span className="font-mono" style={{ color: 'var(--color-text-2)' }}>{a.agentId}</span>
                  <span className="font-mono text-xs" style={{ color: 'var(--color-text-3)' }}>
                    {a.workerId ?? '(stranded)'}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86_400)}d`;
}
