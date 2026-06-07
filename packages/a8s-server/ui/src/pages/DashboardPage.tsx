import { useEffect, useRef, useState } from 'react';
import { Card } from '@arco-design/web-react';
import { useCluster, useWorkers, useAgents } from '../api/queries.js';
import { StatCard } from '../components/StatCard.js';
import { Sparkline } from '../components/Sparkline.js';
import { PageHeader, ErrorBanner, Spinner } from '../components/Page.js';

const HISTORY_MAX = 30; // ~2.5 min at the 5s poll cadence

export function DashboardPage() {
  const cluster = useCluster();
  const workers = useWorkers();
  const agents = useAgents();

  // Accumulate a rolling capacity-% history from each successful poll so the
  // sparkline shows a trend even though a8s keeps no time series.
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

      {/* Hero: capacity trend */}
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
