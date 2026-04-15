import { Bot } from 'lucide-react';
import { useObserveApi } from '../hooks/useObserve';

interface Props {
  baseUrl: string;
  onSelectAgent?: (agentId: string) => void;
}

export function AgentDashboard({ baseUrl, onSelectAgent }: Props) {
  const { data, loading } = useObserveApi<any[]>(baseUrl, '/agents');

  if (loading) return <div className="text-gray-400 dark:text-gray-500 p-4">Loading...</div>;
  if (!data || data.length === 0) return <div className="text-gray-400 dark:text-gray-500 p-4">No agent data</div>;

  return (
    <div className="space-y-4">
      <h3 className="text-lg font-semibold text-gray-800 dark:text-gray-100 flex items-center gap-2">
        <Bot size={18} /> Agent Statistics
      </h3>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
        {data.map((a: any) => (
          <div
            key={a.agentId}
            className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-4 hover:border-indigo-300 dark:hover:border-indigo-600 cursor-pointer transition-colors"
            onClick={() => onSelectAgent?.(a.agentId)}
          >
            <div className="flex items-center gap-2 mb-3">
              <Bot size={16} className="text-indigo-500 dark:text-indigo-400" />
              <span className="font-medium text-gray-800 dark:text-gray-100">{a.agentId}</span>
            </div>
            <div className="grid grid-cols-2 gap-2 text-sm">
              <div><span className="text-gray-500 dark:text-gray-400">Sessions:</span> <span className="font-medium text-gray-800 dark:text-gray-200">{a.sessionCount}</span></div>
              <div><span className="text-gray-500 dark:text-gray-400">Total Cost:</span> <span className="font-medium text-gray-800 dark:text-gray-200">${a.totalCost.toFixed(4)}</span></div>
              <div><span className="text-gray-500 dark:text-gray-400">API Calls:</span> <span className="font-medium text-gray-800 dark:text-gray-200">{a.llmCallCount}</span></div>
              <div><span className="text-gray-500 dark:text-gray-400">Tool Calls:</span> <span className="font-medium text-gray-800 dark:text-gray-200">{a.toolCallCount}</span></div>
              <div className="col-span-2"><span className="text-gray-500 dark:text-gray-400">Avg Cost/Session:</span> <span className="font-medium text-gray-800 dark:text-gray-200">${a.avgCostPerSession.toFixed(4)}</span></div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
