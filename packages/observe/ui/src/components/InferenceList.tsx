import { Clock, Cpu, ArrowRight } from 'lucide-react';
import { useObserveApi } from '../hooks/useObserve';
import type { InferenceRecord } from '../../../src/api-types';
import { OBSERVE_API_PATHS } from '../../../src/api-types';

// Use shared InferenceRecord type (subset used for list display)
type InferenceRow = Pick<InferenceRecord,
  'id' | 'sessionId' | 'provider' | 'model' | 'inputTokens' | 'outputTokens' |
  'cacheReadTokens' | 'totalCost' | 'latencyMs' | 'stopReason' | 'messageCount' |
  'toolDefCount' | 'timestamp'
>;

interface Props {
  baseUrl: string;
  sessionId?: string;
  agentId?: string;
  limit?: number;
  onSelect?: (id: string) => void;
}

export function InferenceList({ baseUrl, sessionId, agentId, limit = 50, onSelect }: Props) {
  const params = new URLSearchParams();
  if (sessionId) params.set('sessionId', sessionId);
  if (agentId) params.set('agentId', agentId);
  params.set('limit', String(limit));

  const { data, loading } = useObserveApi<InferenceRow[]>(baseUrl, `/inferences?${params}`);

  if (loading) return <div className="text-gray-400 p-4">Loading...</div>;
  if (!data || data.length === 0) return <div className="text-gray-400 p-4">No inference records</div>;

  return (
    <div className="space-y-2">
      <h3 className="text-lg font-semibold text-gray-800 flex items-center gap-2">
        <Cpu size={18} /> Inference Records ({data.length})
      </h3>
      <div className="space-y-1">
        {data.map((row) => (
          <div
            key={row.id}
            className="flex items-center justify-between px-4 py-3 bg-white rounded-lg border border-gray-200 hover:border-indigo-300 cursor-pointer transition-colors"
            onClick={() => onSelect?.(row.id)}
          >
            <div className="flex items-center gap-3">
              <StopBadge reason={row.stopReason} />
              <div>
                <div className="text-sm font-mono text-gray-700">{row.model}</div>
                <div className="text-xs text-gray-400">
                  {row.messageCount} msgs · {row.toolDefCount} tools · {new Date(row.timestamp).toLocaleTimeString()}
                </div>
              </div>
            </div>
            <div className="flex items-center gap-4 text-sm">
              <div className="text-right">
                <div className="text-gray-600">{row.inputTokens.toLocaleString()} → {row.outputTokens.toLocaleString()}</div>
                {row.cacheReadTokens > 0 && (
                  <div className="text-xs text-green-600">cache: {row.cacheReadTokens.toLocaleString()}</div>
                )}
              </div>
              <div className="text-right w-16">
                <div className="font-medium text-gray-700">${row.totalCost.toFixed(4)}</div>
                <div className="text-xs text-gray-400 flex items-center gap-1">
                  <Clock size={10} /> {row.latencyMs}ms
                </div>
              </div>
              <ArrowRight size={16} className="text-gray-300" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function StopBadge({ reason }: { reason: string }) {
  const colors = {
    end_turn: 'bg-green-100 text-green-700',
    tool_use: 'bg-blue-100 text-blue-700',
    max_tokens: 'bg-orange-100 text-orange-700',
  };
  return (
    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${colors[reason as keyof typeof colors] ?? 'bg-gray-100 text-gray-600'}`}>
      {reason}
    </span>
  );
}
