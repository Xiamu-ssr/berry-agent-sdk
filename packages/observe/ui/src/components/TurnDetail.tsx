import { ArrowLeft, MessageSquare, AlertTriangle } from 'lucide-react';
import { useObserveApi } from '../hooks/useObserve';
import { MiniStats } from './MiniStats';
import { InferenceList } from './InferenceList';

interface Props {
  baseUrl: string;
  turnId: string;
  onBack?: () => void;
  onSelectInference?: (id: string) => void;
}

export function TurnDetail({ baseUrl, turnId, onBack, onSelectInference }: Props) {
  const { data, loading } = useObserveApi<any>(baseUrl, `/turns/${turnId}`);

  if (loading) return <div className="p-4 text-gray-400 dark:text-gray-500">Loading...</div>;
  if (!data) return <div className="p-4 text-gray-400 dark:text-gray-500">Turn not found</div>;

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center gap-3">
        {onBack && (
          <button onClick={onBack} className="p-1 hover:bg-gray-100 dark:hover:bg-gray-700 rounded">
            <ArrowLeft size={20} className="text-gray-600 dark:text-gray-300" />
          </button>
        )}
        <div>
          <h3 className="text-lg font-bold text-gray-800 dark:text-gray-100 flex items-center gap-2">
            <MessageSquare size={18} /> Turn Detail
          </h3>
          <div className="text-xs font-mono text-gray-400 dark:text-gray-500">{turnId}</div>
        </div>
        <span className={`ml-2 px-2 py-0.5 rounded text-xs ${
          data.status === 'completed' ? 'bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-400' : 'bg-yellow-100 dark:bg-yellow-900/40 text-yellow-700 dark:text-yellow-400'
        }`}>{data.status}</span>
      </div>

      {/* Crash recovery banner (v0.4) — shown when this turn resumed after a crash. */}
      {data.recoveredFromCrash && (
        <div className="bg-amber-50 dark:bg-amber-900/20 border border-amber-300 dark:border-amber-800 rounded-lg px-4 py-3 text-sm flex items-start gap-3">
          <AlertTriangle size={18} className="text-amber-600 dark:text-amber-400 mt-0.5 shrink-0" />
          <div>
            <div className="font-medium text-amber-800 dark:text-amber-300">Crash recovery turn</div>
            <div className="text-amber-700 dark:text-amber-400 mt-0.5">
              This turn resumed a session that crashed during a previous run.
              {data.orphanedToolCount > 0 && (
                <> <span className="font-medium">{data.orphanedToolCount}</span> tool call{data.orphanedToolCount === 1 ? ' was' : 's were'} orphaned (started but never finished).</>
              )}
              {data.previousTurnId && (
                <> Previous turn: <span className="font-mono text-xs">{data.previousTurnId}</span></>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Prompt */}
      {data.prompt && (
        <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg px-4 py-3 text-sm text-gray-700 dark:text-gray-300">
          <div className="text-xs font-medium text-blue-500 dark:text-blue-400 mb-1">User Prompt</div>
          <div className="whitespace-pre-wrap break-words">{data.prompt}</div>
        </div>
      )}

      {/* Stats banner */}
      <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-4">
        <h4 className="text-sm font-semibold text-gray-600 dark:text-gray-300 mb-3">Stats</h4>
        <div className="flex flex-wrap gap-4 text-sm mb-3">
          <div><span className="text-gray-500 dark:text-gray-400">Start:</span> <span className="text-gray-800 dark:text-gray-200">{new Date(data.startTime).toLocaleString()}</span></div>
          {data.endTime && (
            <div><span className="text-gray-500 dark:text-gray-400">Duration:</span> <span className="text-gray-800 dark:text-gray-200">{((data.endTime - data.startTime) / 1000).toFixed(2)}s</span></div>
          )}
          <div><span className="text-gray-500 dark:text-gray-400">API calls:</span> <span className="font-medium text-gray-800 dark:text-gray-200">{data.llmCallCount}</span></div>
          <div><span className="text-gray-500 dark:text-gray-400">Tool calls:</span> <span className="font-medium text-gray-800 dark:text-gray-200">{data.toolCallCount}</span></div>
        </div>
        <MiniStats
          cost={data.cost}
          cache={data.cache}
          guard={data.guard}
        />
      </div>

      {/* Inferences for this turn */}
      <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-4">
        <InferenceList
          baseUrl={baseUrl}
          turnId={turnId}
          limit={50}
          onSelect={onSelectInference}
        />
      </div>
    </div>
  );
}
