import { Zap } from 'lucide-react';
import { useObserveApi } from '../hooks/useObserve';

interface Props {
  baseUrl: string;
  sessionId?: string;
}

export function CacheEfficiency({ baseUrl, sessionId }: Props) {
  const { data } = useObserveApi<any>(baseUrl, `/cache${sessionId ? `?sessionId=${sessionId}` : ''}`);

  if (!data) return null;

  const hitPct = (data.cacheHitRate * 100).toFixed(1);

  return (
    <div className="space-y-4">
      <h3 className="text-lg font-semibold text-gray-800 dark:text-gray-100 flex items-center gap-2">
        <Zap size={18} /> Cache Efficiency
      </h3>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-3 text-center">
          <div className="text-xs text-gray-500 dark:text-gray-400">Hit Rate</div>
          <div className={`text-2xl font-bold ${data.cacheHitRate > 0.5 ? 'text-green-600 dark:text-green-400' : 'text-yellow-600 dark:text-yellow-400'}`}>
            {hitPct}%
          </div>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-3 text-center">
          <div className="text-xs text-gray-500 dark:text-gray-400">Cache Read</div>
          <div className="text-lg font-bold text-green-600 dark:text-green-400">{data.totalCacheReadTokens.toLocaleString()}</div>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-3 text-center">
          <div className="text-xs text-gray-500 dark:text-gray-400">Cache Write</div>
          <div className="text-lg font-bold text-blue-600 dark:text-blue-400">{data.totalCacheWriteTokens.toLocaleString()}</div>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-3 text-center">
          <div className="text-xs text-gray-500 dark:text-gray-400">Savings</div>
          <div className="text-lg font-bold text-green-600 dark:text-green-400">${data.totalSavings.toFixed(4)}</div>
        </div>
      </div>

      {/* Visual hit rate bar */}
      <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-4">
        <div className="flex items-center justify-between text-sm mb-2">
          <span className="text-gray-600 dark:text-gray-300">Cache utilization</span>
          <span className="font-medium text-gray-800 dark:text-gray-100">{hitPct}%</span>
        </div>
        <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-4 overflow-hidden">
          <div
            className={`h-full rounded-full transition-all ${
              data.cacheHitRate > 0.7 ? 'bg-green-400 dark:bg-green-500' : data.cacheHitRate > 0.3 ? 'bg-yellow-400 dark:bg-yellow-500' : 'bg-red-400 dark:bg-red-500'
            }`}
            style={{ width: `${Math.min(data.cacheHitRate * 100, 100)}%` }}
          />
        </div>
        <div className="flex justify-between text-xs text-gray-400 dark:text-gray-500 mt-1">
          <span>0%</span>
          <span>Input: {data.totalInputTokens.toLocaleString()} tokens (uncached)</span>
          <span>100%</span>
        </div>
      </div>
    </div>
  );
}
