import { ArrowLeft, Bot, ArrowRight } from 'lucide-react';
import { useObserveApi } from '../hooks/useObserve';
import { MiniStats } from './MiniStats';

interface SessionRow {
  id: string;
  agentId: string | null;
  startTime: number;
  endTime: number | null;
  totalCost: number;
  status: string;
  llmCallCount: number;
  toolCallCount: number;
}

interface AgentDetailData {
  agentId: string;
  sessionCount: number;
  totalCost: number;
  llmCallCount: number;
  toolCallCount: number;
  avgCostPerSession: number;
  cost: any;
  cache: any;
  guard: any;
  recentSessions: SessionRow[];
}

interface Props {
  baseUrl: string;
  agentId: string;
  onBack?: () => void;
  onSelectSession?: (sessionId: string) => void;
}

export function AgentDetail({ baseUrl, agentId, onBack, onSelectSession }: Props) {
  const { data, loading } = useObserveApi<AgentDetailData>(baseUrl, `/agents/${encodeURIComponent(agentId)}`);

  if (loading) return <div className="p-4 text-gray-400 dark:text-gray-500">Loading...</div>;
  if (!data) return <div className="p-4 text-gray-400 dark:text-gray-500">Agent not found</div>;

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center gap-3">
        {onBack && (
          <button onClick={onBack} className="p-1 hover:bg-gray-100 dark:hover:bg-gray-700 rounded">
            <ArrowLeft size={20} className="text-gray-600 dark:text-gray-300" />
          </button>
        )}
        <h3 className="text-lg font-bold text-gray-800 dark:text-gray-100 flex items-center gap-2">
          <Bot size={18} /> Agent: {data.agentId}
        </h3>
      </div>

      {/* Stats banner */}
      <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-4">
        <div className="flex flex-wrap gap-4 text-sm mb-3">
          <div><span className="text-gray-500 dark:text-gray-400">Sessions:</span> <span className="font-medium text-gray-800 dark:text-gray-200">{data.sessionCount}</span></div>
          <div><span className="text-gray-500 dark:text-gray-400">API Calls:</span> <span className="font-medium text-gray-800 dark:text-gray-200">{data.llmCallCount}</span></div>
          <div><span className="text-gray-500 dark:text-gray-400">Tool Calls:</span> <span className="font-medium text-gray-800 dark:text-gray-200">{data.toolCallCount}</span></div>
          <div><span className="text-gray-500 dark:text-gray-400">Avg Cost/Session:</span> <span className="font-medium text-gray-800 dark:text-gray-200">${data.avgCostPerSession.toFixed(4)}</span></div>
        </div>
        <MiniStats
          cost={data.cost}
          cache={data.cache}
          guard={data.guard}
        />
      </div>

      {/* Recent sessions */}
      {data.recentSessions && data.recentSessions.length > 0 && (
        <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-4">
          <h4 className="text-sm font-semibold text-gray-600 dark:text-gray-300 mb-3">Recent Sessions ({data.recentSessions.length})</h4>
          <div className="space-y-1">
            {data.recentSessions.map((s) => (
              <div
                key={s.id}
                className="flex items-center justify-between px-4 py-3 rounded-lg border border-gray-200 dark:border-gray-700 hover:border-indigo-300 dark:hover:border-indigo-600 cursor-pointer transition-colors"
                onClick={() => onSelectSession?.(s.id)}
              >
                <div>
                  <div className="text-sm font-mono text-gray-700 dark:text-gray-300">{s.id}</div>
                  <div className="text-xs text-gray-400 dark:text-gray-500">{new Date(s.startTime).toLocaleString()}</div>
                </div>
                <div className="flex items-center gap-4 text-xs text-gray-500 dark:text-gray-400">
                  <span>{s.llmCallCount} API calls</span>
                  <span>{s.toolCallCount} tools</span>
                  <span className="font-medium text-gray-700 dark:text-gray-200">${s.totalCost.toFixed(4)}</span>
                  <span className={`px-2 py-0.5 rounded ${s.status === 'completed' ? 'bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-400' : 'bg-yellow-100 dark:bg-yellow-900/40 text-yellow-700 dark:text-yellow-400'}`}>
                    {s.status}
                  </span>
                  <ArrowRight size={14} className="text-gray-300 dark:text-gray-600" />
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
