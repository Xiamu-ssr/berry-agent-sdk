import { TrendingUp, DollarSign } from 'lucide-react';
import { useObserveApi } from '../hooks/useObserve';

interface Props {
  baseUrl: string;
  sessionId?: string;
}

export function CostTrend({ baseUrl, sessionId }: Props) {
  const { data: cost } = useObserveApi<any>(baseUrl, `/cost${sessionId ? `?sessionId=${sessionId}` : ''}`);
  const { data: byModel } = useObserveApi<any[]>(baseUrl, '/cost/by-model');
  const { data: trend } = useObserveApi<any[]>(baseUrl, '/cost/trend');

  return (
    <div className="space-y-4">
      <h3 className="text-lg font-semibold text-gray-800 dark:text-gray-100 flex items-center gap-2">
        <DollarSign size={18} /> Cost Analysis
      </h3>

      {/* Overview */}
      {cost && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-3 text-center">
            <div className="text-xs text-gray-500 dark:text-gray-400">Total Cost</div>
            <div className="text-xl font-bold text-gray-800 dark:text-gray-100">${cost.totalCost?.toFixed(4)}</div>
          </div>
          <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-3 text-center">
            <div className="text-xs text-gray-500 dark:text-gray-400">Input Cost</div>
            <div className="text-lg font-bold text-blue-600 dark:text-blue-400">${cost.inputCost?.toFixed(4)}</div>
          </div>
          <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-3 text-center">
            <div className="text-xs text-gray-500 dark:text-gray-400">Output Cost</div>
            <div className="text-lg font-bold text-purple-600 dark:text-purple-400">${cost.outputCost?.toFixed(4)}</div>
          </div>
          <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-3 text-center">
            <div className="text-xs text-gray-500 dark:text-gray-400">Cache Savings</div>
            <div className="text-lg font-bold text-green-600 dark:text-green-400">${cost.cacheSavings?.toFixed(4)}</div>
          </div>
        </div>
      )}

      {/* By model */}
      {byModel && byModel.length > 0 && (
        <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-4">
          <h4 className="text-sm font-semibold text-gray-600 dark:text-gray-300 mb-3">Cost by Model</h4>
          <div className="space-y-2">
            {byModel.map((m: any) => (
              <div key={m.model} className="flex items-center justify-between text-sm">
                <span className="font-mono text-gray-700 dark:text-gray-300">{m.model}</span>
                <div className="flex items-center gap-4 text-gray-500 dark:text-gray-400">
                  <span>{m.callCount} calls</span>
                  <span>{m.inputTokens.toLocaleString()} in / {m.outputTokens.toLocaleString()} out</span>
                  <span className="font-medium text-gray-700 dark:text-gray-200">${m.totalCost.toFixed(4)}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Daily trend (simple text table since no chart lib) */}
      {trend && trend.length > 0 && (
        <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-4">
          <h4 className="text-sm font-semibold text-gray-600 dark:text-gray-300 mb-3 flex items-center gap-2">
            <TrendingUp size={14} /> Daily Trend
          </h4>
          <div className="space-y-1">
            {trend.slice(-14).map((d: any) => {
              const maxCost = Math.max(...trend.map((t: any) => t.totalCost), 0.001);
              const barWidth = (d.totalCost / maxCost) * 100;
              return (
                <div key={d.date} className="flex items-center gap-3 text-xs">
                  <span className="w-20 text-gray-500 dark:text-gray-400">{d.date}</span>
                  <div className="flex-1 bg-gray-100 dark:bg-gray-700 rounded-full h-4 overflow-hidden">
                    <div className="h-full bg-indigo-400 dark:bg-indigo-500 rounded-full" style={{ width: `${barWidth}%` }} />
                  </div>
                  <span className="w-20 text-right text-gray-600 dark:text-gray-300">${d.totalCost.toFixed(4)}</span>
                  <span className="w-16 text-right text-gray-400 dark:text-gray-500">{d.callCount} calls</span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
