import { useCluster, useWorkers, useAgents } from '../api/queries.js';
import { StatCard } from '../components/StatCard.js';
import { PageHeader, ErrorBanner, Spinner } from '../components/Page.js';

export function DashboardPage() {
  const cluster = useCluster();
  const workers = useWorkers();
  const agents = useAgents();

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

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          label="Active workers"
          value={c.workerCount.active}
          hint={`${c.workerCount.total} total · ${c.workerCount.draining} draining`}
          tone={c.workerCount.active === 0 ? 'warn' : 'success'}
        />
        <StatCard
          label="Capacity used"
          value={`${capacityPct}%`}
          hint={`${c.capacity.used} of ${c.capacity.total} slots`}
          tone={capacityPct > 80 ? 'warn' : 'default'}
        />
        <StatCard
          label="Agents"
          value={c.agentCount}
          hint="assigned to workers"
        />
        <StatCard
          label="Available slots"
          value={c.capacity.available}
          tone={c.capacity.available === 0 ? 'danger' : 'default'}
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="card">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-ink-500 dark:text-ink-400 mb-3">
            Worker pool
          </h2>
          {activeWorkers.length === 0 ? (
            <div className="text-sm text-ink-500 dark:text-ink-400">No active workers — agents cannot be scheduled.</div>
          ) : (
            <ul className="space-y-2">
              {activeWorkers.map((w) => (
                <li key={w.workerId} className="flex items-center justify-between text-sm">
                  <span className="font-mono text-ink-700 dark:text-ink-200">{w.workerId}</span>
                  <span className="text-ink-500 dark:text-ink-400 tabular-nums">
                    {w.used} / {w.capacity}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="card">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-ink-500 dark:text-ink-400 mb-3">
            Latest agents
          </h2>
          {recentAgents.length === 0 ? (
            <div className="text-sm text-ink-500 dark:text-ink-400">No agents yet.</div>
          ) : (
            <ul className="space-y-2">
              {recentAgents.map((a) => (
                <li key={a.agentId} className="flex items-center justify-between text-sm">
                  <span className="font-mono text-ink-700 dark:text-ink-200">{a.agentId}</span>
                  <span className="text-ink-500 dark:text-ink-400 font-mono text-xs">
                    {a.workerId ?? '(stranded)'}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
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
