import { MessageSquare, ArrowRight } from 'lucide-react';
import { useObserveApi } from '../hooks/useObserve';

interface TurnRow {
  id: string;
  sessionId: string;
  agentId: string | null;
  prompt: string | null;
  startTime: number;
  endTime: number | null;
  llmCallCount: number;
  toolCallCount: number;
  totalCost: number;
  status: string;
}

interface Props {
  baseUrl: string;
  sessionId?: string;
  agentId?: string;
  limit?: number;
  onSelect?: (turnId: string) => void;
}

export function TurnList({ baseUrl, sessionId, agentId, limit = 50, onSelect }: Props) {
  const params = new URLSearchParams();
  if (sessionId) params.set('sessionId', sessionId);
  if (agentId) params.set('agentId', agentId);
  params.set('limit', String(limit));

  const { data, loading } = useObserveApi<TurnRow[]>(baseUrl, `/turns?${params}`);

  if (loading) return <div className="text-gray-400 dark:text-gray-500 p-4">Loading...</div>;
  if (!data || data.length === 0) return <div className="text-gray-400 dark:text-gray-500 p-4">No turns recorded</div>;

  return (
    <div className="space-y-2">
      <h4 className="text-sm font-semibold text-gray-700 dark:text-gray-200 flex items-center gap-2">
        <MessageSquare size={16} /> Turns ({data.length})
      </h4>
      <div className="space-y-1">
        {data.map((t) => (
          <div
            key={t.id}
            className="flex items-center justify-between px-4 py-3 bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 hover:border-indigo-300 dark:hover:border-indigo-600 cursor-pointer transition-colors"
            onClick={() => onSelect?.(t.id)}
          >
            <div className="flex-1 min-w-0">
              <div className="text-sm text-gray-700 dark:text-gray-300 truncate">
                {t.prompt ? `"${t.prompt.slice(0, 80)}${t.prompt.length > 80 ? '...' : ''}"` : <span className="text-gray-400 dark:text-gray-500 italic">no prompt</span>}
              </div>
              <div className="text-xs text-gray-400 dark:text-gray-500 mt-0.5">
                {new Date(t.startTime).toLocaleString()} ·
                {t.endTime ? ` ${t.endTime - t.startTime}ms` : ' active'}
              </div>
            </div>
            <div className="flex items-center gap-4 ml-4 text-xs text-gray-500 dark:text-gray-400 shrink-0">
              <span>{t.llmCallCount} API calls</span>
              <span>{t.toolCallCount} tools</span>
              <span className="font-medium text-gray-700 dark:text-gray-200">${t.totalCost.toFixed(4)}</span>
              <span className={`px-2 py-0.5 rounded ${t.status === 'completed' ? 'bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-400' : 'bg-yellow-100 dark:bg-yellow-900/40 text-yellow-700 dark:text-yellow-400'}`}>
                {t.status}
              </span>
              <ArrowRight size={14} className="text-gray-300 dark:text-gray-600" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
