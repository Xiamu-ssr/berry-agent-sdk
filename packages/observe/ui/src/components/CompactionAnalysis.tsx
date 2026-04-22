import { Layers, ArrowDown } from 'lucide-react';
import { useObserveApi } from '../hooks/useObserve';

interface Props {
  baseUrl: string;
  sessionId?: string;
}

export function CompactionAnalysis({ baseUrl, sessionId }: Props) {
  const params = sessionId ? `?sessionId=${sessionId}` : '';
  const { data: stats } = useObserveApi<any>(baseUrl, `/compaction${params}`);
  const { data: list } = useObserveApi<any[]>(baseUrl, `/compaction/list${params}`);

  return (
    <div className="space-y-4">
      <h3 className="text-lg font-semibold text-gray-800 dark:text-gray-100 flex items-center gap-2">
        <Layers size={18} /> Compaction Analysis
      </h3>

      {/* Stats summary */}
      {stats && stats.totalCount > 0 && (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          <MiniStat label="Total" value={stats.totalCount} />
          <MiniStat label="Avg Tokens Freed" value={Math.round(stats.avgTokensFreed).toLocaleString()} />
          <MiniStat label="Avg Duration" value={`${Math.round(stats.avgDurationMs)}ms`} />
          <MiniStat label="Avg Reduction" value={`${(stats.avgReductionPct * 100).toFixed(1)}%`} />
          <MiniStat label="Avg Threshold" value={`${(stats.avgThresholdPct * 100).toFixed(0)}%`} />
        </div>
      )}

      {/* Trigger frequency */}
      {stats?.byTrigger?.length > 0 && (
        <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-4">
          <h4 className="text-sm font-semibold text-gray-600 dark:text-gray-300 mb-2">Trigger Frequency</h4>
          <div className="flex flex-wrap gap-2">
            {stats.byTrigger.map((t: any) => (
              <span key={t.reason} className="px-2 py-1 bg-yellow-50 dark:bg-yellow-900/30 text-yellow-700 dark:text-yellow-300 rounded text-xs font-mono">
                {t.reason} ({t.count})
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Layer frequency */}
      {stats?.byLayer?.length > 0 && (
        <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-4">
          <h4 className="text-sm font-semibold text-gray-600 dark:text-gray-300 mb-2">Layer Frequency</h4>
          <div className="flex flex-wrap gap-2">
            {stats.byLayer.map((l: any) => (
              <span key={l.layer} className="px-2 py-1 bg-indigo-50 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-300 rounded text-xs font-mono">
                {l.layer} ({l.count})
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Event list */}
      {list && list.length > 0 && (
        <div className="space-y-2">
          {list.map((evt: any) => {
            const layers = safeParse(evt.layersApplied) ?? [];
            const reductionPct = evt.contextBefore > 0
              ? ((evt.contextBefore - evt.contextAfter) / evt.contextBefore * 100).toFixed(1)
              : '0';

            return (
              <div key={evt.id} className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 px-4 py-3 text-sm">
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <span className={`px-2 py-0.5 rounded text-xs font-medium ${
                      evt.triggerReason === 'threshold' ? 'bg-yellow-100 dark:bg-yellow-900/40 text-yellow-700 dark:text-yellow-400' : 'bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-400'
                    }`}>
                      {evt.triggerReason}
                    </span>
                    <span className="text-gray-400 dark:text-gray-500 text-xs">{new Date(evt.timestamp).toLocaleTimeString()}</span>
                  </div>
                  <span className="text-gray-400 dark:text-gray-500 text-xs">{evt.durationMs}ms</span>
                </div>

                <div className="flex items-center gap-2 text-xs">
                  <span className="text-gray-500 dark:text-gray-400">{evt.contextBefore.toLocaleString()} tokens</span>
                  <ArrowDown size={12} className="text-green-500 dark:text-green-400" />
                  <span className="text-green-600 dark:text-green-400 font-medium">{evt.contextAfter.toLocaleString()} tokens</span>
                  <span className="text-gray-400 dark:text-gray-500">(-{reductionPct}%)</span>
                  <span className="text-gray-400 dark:text-gray-500 ml-2">
                    freed {evt.tokensFreed?.toLocaleString() ?? '?'} tokens
                  </span>
                  <span className="text-gray-400 dark:text-gray-500">
                    at {(evt.thresholdPct * 100).toFixed(0)}% of {evt.contextWindow.toLocaleString()} window
                  </span>
                </div>

                <div className="flex flex-wrap gap-1 mt-2">
                  {layers.map((l: string, i: number) => (
                    <span key={i} className="px-1.5 py-0.5 bg-gray-100 dark:bg-gray-700 rounded text-xs font-mono text-gray-600 dark:text-gray-300">{l}</span>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {(!list || list.length === 0) && (
        <div className="text-gray-400 dark:text-gray-500 text-sm p-4">No compaction events recorded</div>
      )}
    </div>
  );
}

function MiniStat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-3 text-center">
      <div className="text-xs text-gray-500 dark:text-gray-400">{label}</div>
      <div className="text-lg font-bold text-gray-800 dark:text-gray-100">{value}</div>
    </div>
  );
}

function safeParse(json: string | null): any {
  if (!json) return null;
  try { return JSON.parse(json); } catch { return null; }
}
