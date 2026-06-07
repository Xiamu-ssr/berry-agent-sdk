import { Bot, DollarSign, Crown } from 'lucide-react';
import { useObserveApi } from '../hooks/useObserve';
import { rankAgentsByCost, formatShare, type AgentCostRow } from '../lib/agentCostLayers';

interface Props {
  baseUrl: string;
  onSelectAgent?: (agentId: string) => void;
}

export function AgentDashboard({ baseUrl, onSelectAgent }: Props) {
  const { data, loading } = useObserveApi<AgentCostRow[]>(baseUrl, '/agents');

  if (loading) return <div className="text-gray-400 dark:text-gray-500 p-4">Loading...</div>;
  if (!data || data.length === 0) return <div className="text-gray-400 dark:text-gray-500 p-4">No agent data</div>;

  const layers = rankAgentsByCost(data);

  return (
    <div className="space-y-4">
      <h3 className="text-lg font-semibold text-gray-800 dark:text-gray-100 flex items-center gap-2">
        <Bot size={18} /> Agent Statistics
      </h3>

      {/* Layered roll-up: where the spend concentrates across agents. */}
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
        <SummaryCard
          icon={<DollarSign size={18} />}
          label="Total cost"
          value={`$${layers.totalCost.toFixed(4)}`}
          sub={`${layers.agentCount} agent${layers.agentCount === 1 ? '' : 's'}`}
        />
        <SummaryCard
          icon={<Crown size={18} />}
          label="Top spender"
          value={layers.topSpender ? layers.topSpender.agentId : '—'}
          sub={layers.topSpender ? `${formatShare(layers.topSpender.share)} of total` : ''}
        />
        <SummaryCard
          icon={<Bot size={18} />}
          label="Avg / agent"
          value={`$${(layers.agentCount ? layers.totalCost / layers.agentCount : 0).toFixed(4)}`}
          sub="mean total cost"
        />
      </div>

      {/* Per-agent rows, ranked by spend, each with a cost-share bar. */}
      <div className="space-y-2">
        {layers.agents.map((a) => (
          <button
            key={a.agentId}
            type="button"
            onClick={() => onSelectAgent?.(a.agentId)}
            className="w-full text-left bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-4 hover:border-indigo-300 dark:hover:border-indigo-600 cursor-pointer transition-colors"
          >
            <div className="flex items-center justify-between gap-3 mb-2">
              <div className="flex min-w-0 items-center gap-2">
                <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-[11px] font-semibold text-gray-500 dark:text-gray-400 bg-gray-100 dark:bg-gray-700">
                  {a.rank}
                </span>
                <Bot size={16} className="text-indigo-500 dark:text-indigo-400 shrink-0" />
                <span className="truncate font-medium text-gray-800 dark:text-gray-100">{a.agentId}</span>
              </div>
              <div className="flex shrink-0 items-baseline gap-2">
                <span className="font-semibold tabular-nums text-gray-800 dark:text-gray-100">${a.totalCost.toFixed(4)}</span>
                <span className="text-xs tabular-nums text-gray-400 dark:text-gray-500">{formatShare(a.share)}</span>
              </div>
            </div>

            {/* Cost-share bar */}
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-gray-100 dark:bg-gray-700">
              <div
                className="h-full rounded-full bg-indigo-500 dark:bg-indigo-400"
                style={{ width: `${Math.max(a.share * 100, a.totalCost > 0 ? 2 : 0)}%` }}
              />
            </div>

            <div className="mt-2 grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
              <Stat label="Sessions" value={String(a.sessionCount)} />
              <Stat label="API calls" value={String(a.llmCallCount)} />
              <Stat label="Tool calls" value={String(a.toolCallCount)} />
              <Stat label="Avg/session" value={`$${a.avgCostPerSession.toFixed(4)}`} />
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

function SummaryCard({ icon, label, value, sub }: {
  icon: React.ReactNode; label: string; value: string; sub: string;
}) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
      <div className="mb-2 flex items-center gap-2 text-gray-500 dark:text-gray-400">
        {icon}
        <span className="text-sm font-medium">{label}</span>
      </div>
      <div className="truncate text-xl font-semibold text-gray-900 dark:text-gray-100">{value}</div>
      <div className="mt-1 text-xs text-gray-400 dark:text-gray-500">{sub}</div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span className="text-gray-500 dark:text-gray-400">{label}:</span>{' '}
      <span className="font-medium text-gray-800 dark:text-gray-200">{value}</span>
    </div>
  );
}
