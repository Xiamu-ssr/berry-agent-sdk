import { BarChart3, DollarSign, Zap, Shield, Layers } from 'lucide-react';
import { useObserveApi } from '../hooks/useObserve';

interface Props {
  baseUrl: string;
  onNavigate?: (path: string) => void;
}

export function GlobalDashboard({ baseUrl, onNavigate }: Props) {
  const { data: cost } = useObserveApi<any>(baseUrl, '/cost');
  const { data: cache } = useObserveApi<any>(baseUrl, '/cache');
  const { data: guard } = useObserveApi<any>(baseUrl, '/guard');
  const { data: compaction } = useObserveApi<any>(baseUrl, '/compaction');

  return (
    <div className="space-y-6">
      <div>
        <h2 className="flex items-center gap-2 text-xl font-semibold text-gray-900 dark:text-zinc-100">
          <BarChart3 size={20} className="text-blue-600 dark:text-sky-300" />
          Overview
        </h2>
        <p className="mt-1 text-sm text-gray-500 dark:text-zinc-500">
          Runtime cost, cache, guard, and compaction signals from the SDK observer.
        </p>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          icon={<DollarSign size={20} />}
          label="Total Cost"
          value={cost ? `$${cost.totalCost?.toFixed(4)}` : '—'}
          sub={cost ? `${cost.callCount} API calls` : ''}
          onClick={() => onNavigate?.('/cost')}
        />
        <StatCard
          icon={<Zap size={20} />}
          label="Cache Hit Rate"
          value={cache ? `${(cache.cacheHitRate * 100).toFixed(1)}%` : '—'}
          sub={cache ? `$${cache.totalSavings?.toFixed(4)} saved` : ''}
          onClick={() => onNavigate?.('/cache')}
        />
        <StatCard
          icon={<Shield size={20} />}
          label="Guard Decisions"
          value={guard ? `${guard.allowCount + guard.denyCount}` : '—'}
          sub={guard ? `${guard.denyCount} denied` : ''}
          color={guard?.denyCount > 0 ? 'red' : 'green'}
          onClick={() => onNavigate?.('/guard')}
        />
        <StatCard
          icon={<Layers size={20} />}
          label="Compactions"
          value={compaction ? `${compaction.totalCount}` : '—'}
          sub={compaction?.totalCount > 0 ? `avg ${Math.round(compaction.avgTokensFreed)} tokens freed` : ''}
          onClick={() => onNavigate?.('/compaction')}
        />
      </div>
    </div>
  );
}

function StatCard({ icon, label, value, sub, color, onClick }: {
  icon: React.ReactNode; label: string; value: string; sub: string; color?: string;
  onClick?: () => void;
}) {
  const borderColor = color === 'red'
    ? 'border-red-200 dark:border-red-800'
    : color === 'green'
      ? 'border-green-200 dark:border-green-800'
      : 'border-gray-200 dark:border-gray-700';
  return (
    <div
      className={`cursor-pointer rounded-xl border bg-white p-4 transition-colors hover:border-blue-300 hover:bg-blue-50/40 dark:border-white/[0.08] dark:bg-[#20242a]/75 dark:hover:border-sky-300/25 dark:hover:bg-sky-300/[0.06] ${borderColor}`}
      onClick={onClick}
    >
      <div className="mb-2 flex items-center gap-2 text-gray-500 dark:text-zinc-500">
        {icon}
        <span className="text-sm font-medium">{label}</span>
      </div>
      <div className="text-2xl font-semibold text-gray-900 dark:text-zinc-100">{value}</div>
      <div className="mt-1 text-xs text-gray-400 dark:text-zinc-600">{sub}</div>
    </div>
  );
}
