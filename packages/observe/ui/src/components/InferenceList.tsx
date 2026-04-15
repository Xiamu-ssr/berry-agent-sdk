import { useState } from 'react';
import { Clock, Cpu, ArrowRight, Filter } from 'lucide-react';
import { useObserveApi } from '../hooks/useObserve';
import type { InferenceRecord } from '../../../src/analyzer/api-types';

// Use shared InferenceRecord type (subset used for list display)
type InferenceRow = Pick<InferenceRecord,
  'id' | 'sessionId' | 'agentId' | 'turnId' | 'provider' | 'model' | 'inputTokens' | 'outputTokens' |
  'cacheReadTokens' | 'totalCost' | 'latencyMs' | 'stopReason' | 'messageCount' |
  'toolDefCount' | 'timestamp'
>;

interface Props {
  baseUrl: string;
  sessionId?: string;
  agentId?: string;
  turnId?: string;
  limit?: number;
  onSelect?: (id: string) => void;
}

export function InferenceList({ baseUrl, sessionId, agentId, turnId, limit = 50, onSelect }: Props) {
  const [modelFilter, setModelFilter] = useState('');
  const [stopFilter, setStopFilter] = useState('');
  const [showFilters, setShowFilters] = useState(false);

  const params = new URLSearchParams();
  if (sessionId) params.set('sessionId', sessionId);
  if (agentId) params.set('agentId', agentId);
  if (turnId) params.set('turnId', turnId);
  if (modelFilter) params.set('model', modelFilter);
  params.set('limit', String(limit));

  const { data, loading } = useObserveApi<InferenceRow[]>(baseUrl, `/inferences?${params}`);

  // Client-side stop reason filter (since server doesn't support it yet)
  const filtered = data
    ? stopFilter
      ? data.filter(r => r.stopReason === stopFilter)
      : data
    : null;

  if (loading) return <div className="text-gray-400 dark:text-gray-500 p-4">Loading...</div>;
  if (!filtered || filtered.length === 0) return (
    <div className="space-y-2">
      <InferenceHeader
        count={0}
        showFilters={showFilters}
        onToggleFilters={() => setShowFilters(!showFilters)}
        modelFilter={modelFilter}
        stopFilter={stopFilter}
        onModelChange={setModelFilter}
        onStopChange={setStopFilter}
      />
      <div className="text-gray-400 dark:text-gray-500 text-sm p-4">No inference records</div>
    </div>
  );

  return (
    <div className="space-y-2">
      <InferenceHeader
        count={filtered.length}
        showFilters={showFilters}
        onToggleFilters={() => setShowFilters(!showFilters)}
        modelFilter={modelFilter}
        stopFilter={stopFilter}
        onModelChange={setModelFilter}
        onStopChange={setStopFilter}
      />

      <div className="space-y-1">
        {filtered.map((row) => (
          <div
            key={row.id}
            className="flex items-center justify-between px-4 py-3 bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 hover:border-indigo-300 dark:hover:border-indigo-600 cursor-pointer transition-colors"
            onClick={() => onSelect?.(row.id)}
          >
            <div className="flex items-center gap-3">
              <StopBadge reason={row.stopReason} />
              <div>
                <div className="text-sm font-mono text-gray-700 dark:text-gray-300">{row.model}</div>
                <div className="text-xs text-gray-400 dark:text-gray-500">
                  {row.messageCount} msgs · {row.toolDefCount} tools · {new Date(row.timestamp).toLocaleTimeString()}
                  {row.turnId && <span className="ml-1 text-indigo-400 dark:text-indigo-500">turn</span>}
                </div>
              </div>
            </div>
            <div className="flex items-center gap-4 text-sm">
              <div className="text-right">
                <div className="text-gray-600 dark:text-gray-300">{row.inputTokens.toLocaleString()} → {row.outputTokens.toLocaleString()}</div>
                {row.cacheReadTokens > 0 && (
                  <div className="text-xs text-green-600 dark:text-green-400">cache: {row.cacheReadTokens.toLocaleString()}</div>
                )}
              </div>
              <div className="text-right w-16">
                <div className="font-medium text-gray-700 dark:text-gray-200">${row.totalCost.toFixed(4)}</div>
                <div className="text-xs text-gray-400 dark:text-gray-500 flex items-center gap-1">
                  <Clock size={10} /> {row.latencyMs}ms
                </div>
              </div>
              <ArrowRight size={16} className="text-gray-300 dark:text-gray-600" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ===== Sub-components =====

function InferenceHeader({ count, showFilters, onToggleFilters, modelFilter, stopFilter, onModelChange, onStopChange }: {
  count: number; showFilters: boolean; onToggleFilters: () => void;
  modelFilter: string; stopFilter: string;
  onModelChange: (v: string) => void; onStopChange: (v: string) => void;
}) {
  const hasFilters = modelFilter || stopFilter;
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold text-gray-800 dark:text-gray-100 flex items-center gap-2">
          <Cpu size={18} /> Inference Records ({count})
        </h3>
        <button
          onClick={onToggleFilters}
          className={`flex items-center gap-1 px-3 py-1.5 rounded-lg text-sm border transition-colors ${
            hasFilters
              ? 'bg-indigo-50 dark:bg-indigo-900/30 border-indigo-300 dark:border-indigo-700 text-indigo-700 dark:text-indigo-300'
              : 'bg-white dark:bg-gray-800 border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700'
          }`}
        >
          <Filter size={14} /> Filters {hasFilters ? '•' : ''}
        </button>
      </div>

      {showFilters && (
        <div className="flex flex-wrap gap-3 p-3 bg-gray-50 dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700">
          <div className="flex items-center gap-2">
            <label className="text-xs text-gray-500 dark:text-gray-400 font-medium">Model</label>
            <input
              value={modelFilter}
              onChange={e => onModelChange(e.target.value)}
              placeholder="e.g. claude-sonnet-4"
              className="text-sm px-2 py-1 border border-gray-300 dark:border-gray-600 rounded w-44 focus:outline-none focus:border-indigo-400 dark:focus:border-indigo-500 bg-white dark:bg-gray-700 text-gray-800 dark:text-gray-200"
            />
          </div>
          <div className="flex items-center gap-2">
            <label className="text-xs text-gray-500 dark:text-gray-400 font-medium">Stop Reason</label>
            <select
              value={stopFilter}
              onChange={e => onStopChange(e.target.value)}
              className="text-sm px-2 py-1 border border-gray-300 dark:border-gray-600 rounded focus:outline-none focus:border-indigo-400 dark:focus:border-indigo-500 bg-white dark:bg-gray-700 text-gray-800 dark:text-gray-200"
            >
              <option value="">All</option>
              <option value="end_turn">end_turn</option>
              <option value="tool_use">tool_use</option>
              <option value="max_tokens">max_tokens</option>
            </select>
          </div>
          {(modelFilter || stopFilter) && (
            <button
              onClick={() => { onModelChange(''); onStopChange(''); }}
              className="text-xs text-red-500 dark:text-red-400 hover:text-red-700 dark:hover:text-red-300 px-2 py-1"
            >
              Clear all
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function StopBadge({ reason }: { reason: string }) {
  const colors = {
    end_turn: 'bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-400',
    tool_use: 'bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-400',
    max_tokens: 'bg-orange-100 dark:bg-orange-900/40 text-orange-700 dark:text-orange-400',
  };
  return (
    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${colors[reason as keyof typeof colors] ?? 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300'}`}>
      {reason}
    </span>
  );
}
