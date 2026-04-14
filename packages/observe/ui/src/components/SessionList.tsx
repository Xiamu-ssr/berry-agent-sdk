import { MessageSquare, ArrowRight } from 'lucide-react';
import { useObserveApi } from '../hooks/useObserve';

interface Props {
  baseUrl: string;
  onSelect?: (sessionId: string) => void;
}

export function SessionList({ baseUrl, onSelect }: Props) {
  const { data, loading } = useObserveApi<any[]>(baseUrl, '/sessions');

  if (loading) return <div className="text-gray-400 p-4">Loading...</div>;
  if (!data || data.length === 0) return <div className="text-gray-400 p-4">No sessions</div>;

  return (
    <div className="space-y-2">
      <h3 className="text-lg font-semibold text-gray-800 flex items-center gap-2">
        <MessageSquare size={18} /> Sessions ({data.length})
      </h3>
      <div className="space-y-1">
        {data.map((s: any) => (
          <div
            key={s.id}
            className="flex items-center justify-between px-4 py-3 bg-white rounded-lg border border-gray-200 hover:border-indigo-300 cursor-pointer"
            onClick={() => onSelect?.(s.id)}
          >
            <div>
              <div className="text-sm font-mono text-gray-700">{s.id}</div>
              <div className="text-xs text-gray-400">
                {new Date(s.startTime).toLocaleString()} ·
                {s.agentId && <span className="ml-1">agent: {s.agentId}</span>}
              </div>
            </div>
            <div className="flex items-center gap-4 text-xs text-gray-500">
              <span>{s.llmCallCount} API calls</span>
              <span>{s.toolCallCount} tools</span>
              <span className="font-medium text-gray-700">${s.totalCost?.toFixed(4)}</span>
              <span className={`px-2 py-0.5 rounded ${s.status === 'completed' ? 'bg-green-100 text-green-700' : 'bg-yellow-100 text-yellow-700'}`}>
                {s.status}
              </span>
              <ArrowRight size={14} className="text-gray-300" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
