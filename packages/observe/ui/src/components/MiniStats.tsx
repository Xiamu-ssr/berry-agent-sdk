import { DollarSign, Zap, Shield, Layers } from 'lucide-react';

interface MiniStatsProps {
  cost?: { totalCost: number; callCount: number } | null;
  cache?: { cacheHitRate: number; totalSavings: number } | null;
  guard?: { allowCount: number; denyCount: number; modifyCount: number } | null;
  compaction?: { totalCount: number; avgTokensFreed: number } | null;
}

/**
 * Reusable horizontal stats bar showing Cost | Cache Hit Rate | Guard | Compactions.
 * Used in AgentDetail, SessionDetail, TurnDetail, and as an overview bar.
 */
export function MiniStats({ cost, cache, guard, compaction }: MiniStatsProps) {
  return (
    <div className="flex flex-wrap gap-3">
      {cost != null && (
        <MiniCard
          icon={<DollarSign size={14} />}
          label="Cost"
          value={`$${cost.totalCost.toFixed(4)}`}
          sub={`${cost.callCount} API calls`}
          color="indigo"
        />
      )}
      {cache != null && (
        <MiniCard
          icon={<Zap size={14} />}
          label="Cache"
          value={`${(cache.cacheHitRate * 100).toFixed(1)}%`}
          sub={`$${cache.totalSavings.toFixed(4)} saved`}
          color="green"
        />
      )}
      {guard != null && (
        <MiniCard
          icon={<Shield size={14} />}
          label="Guard"
          value={`${guard.allowCount + guard.denyCount + guard.modifyCount}`}
          sub={guard.denyCount > 0 ? `${guard.denyCount} denied` : 'all allowed'}
          color={guard.denyCount > 0 ? 'red' : 'green'}
        />
      )}
      {compaction != null && (
        <MiniCard
          icon={<Layers size={14} />}
          label="Compactions"
          value={`${compaction.totalCount}`}
          sub={compaction.totalCount > 0 ? `avg ${Math.round(compaction.avgTokensFreed)} freed` : ''}
          color="purple"
        />
      )}
    </div>
  );
}

function MiniCard({ icon, label, value, sub, color }: {
  icon: React.ReactNode; label: string; value: string; sub: string; color?: string;
}) {
  const borderMap: Record<string, string> = {
    indigo: 'border-indigo-200 bg-indigo-50',
    green: 'border-green-200 bg-green-50',
    red: 'border-red-200 bg-red-50',
    purple: 'border-purple-200 bg-purple-50',
  };
  const textMap: Record<string, string> = {
    indigo: 'text-indigo-700',
    green: 'text-green-700',
    red: 'text-red-700',
    purple: 'text-purple-700',
  };
  const cls = borderMap[color ?? 'indigo'] ?? borderMap['indigo'];
  const txt = textMap[color ?? 'indigo'] ?? textMap['indigo'];
  return (
    <div className={`flex items-center gap-2 px-3 py-2 rounded-lg border ${cls} min-w-[120px]`}>
      <span className={txt}>{icon}</span>
      <div>
        <div className="text-xs text-gray-500">{label}</div>
        <div className={`text-sm font-bold ${txt}`}>{value}</div>
        {sub && <div className="text-xs text-gray-400">{sub}</div>}
      </div>
    </div>
  );
}
