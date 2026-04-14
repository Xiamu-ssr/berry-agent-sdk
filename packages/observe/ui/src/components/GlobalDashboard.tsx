import { DollarSign, Zap, Shield, Layers } from 'lucide-react';
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
      <h2 className="text-xl font-bold text-gray-800">📊 Overview</h2>

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
  const borderColor = color === 'red' ? 'border-red-200' : color === 'green' ? 'border-green-200' : 'border-gray-200';
  return (
    <div
      className={`bg-white rounded-xl border ${borderColor} p-4 cursor-pointer hover:shadow-md transition-shadow`}
      onClick={onClick}
    >
      <div className="flex items-center gap-2 text-gray-500 mb-2">
        {icon}
        <span className="text-sm font-medium">{label}</span>
      </div>
      <div className="text-2xl font-bold text-gray-800">{value}</div>
      <div className="text-xs text-gray-400 mt-1">{sub}</div>
    </div>
  );
}
