import { ArrowLeft, MessageSquare } from 'lucide-react';
import { useObserveApi } from '../hooks/useObserve';
import { MiniStats } from './MiniStats';
import { TurnList } from './TurnList';

interface Props {
  baseUrl: string;
  sessionId: string;
  onBack?: () => void;
  onSelectTurn?: (turnId: string) => void;
  onSelectInference?: (id: string) => void;
}

export function SessionDetail({ baseUrl, sessionId, onBack, onSelectTurn, onSelectInference }: Props) {
  const { data: session, loading } = useObserveApi<any>(baseUrl, `/sessions/${sessionId}`);
  const { data: cost } = useObserveApi<any>(baseUrl, `/cost?sessionId=${sessionId}`);
  const { data: cache } = useObserveApi<any>(baseUrl, `/cache?sessionId=${sessionId}`);
  const { data: guard } = useObserveApi<any>(baseUrl, `/guard?sessionId=${sessionId}`);
  const { data: compaction } = useObserveApi<any>(baseUrl, `/compaction?sessionId=${sessionId}`);

  if (loading) return <div className="p-4 text-gray-400 dark:text-gray-500">Loading...</div>;
  if (!session) return <div className="p-4 text-gray-400 dark:text-gray-500">Session not found</div>;

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
            <MessageSquare size={18} /> Session Detail
          </h3>
          <div className="text-xs font-mono text-gray-400 dark:text-gray-500">{sessionId}</div>
        </div>
        <span className={`ml-2 px-2 py-0.5 rounded text-xs ${
          session.status === 'completed' ? 'bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-400' : 'bg-yellow-100 dark:bg-yellow-900/40 text-yellow-700 dark:text-yellow-400'
        }`}>{session.status}</span>
      </div>

      {/* Stats banner */}
      <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-4">
        <h4 className="text-sm font-semibold text-gray-600 dark:text-gray-300 mb-3">Session Stats</h4>
        <div className="flex flex-wrap gap-4 text-sm mb-3">
          {session.agentId && (
            <div><span className="text-gray-500 dark:text-gray-400">Agent:</span> <span className="font-medium text-gray-800 dark:text-gray-200">{session.agentId}</span></div>
          )}
          <div><span className="text-gray-500 dark:text-gray-400">Started:</span> <span className="text-gray-800 dark:text-gray-200">{new Date(session.startTime).toLocaleString()}</span></div>
          {session.endTime && (
            <div><span className="text-gray-500 dark:text-gray-400">Duration:</span> <span className="text-gray-800 dark:text-gray-200">{((session.endTime - session.startTime) / 1000).toFixed(2)}s</span></div>
          )}
          <div><span className="text-gray-500 dark:text-gray-400">API calls:</span> <span className="font-medium text-gray-800 dark:text-gray-200">{session.llmCallCount}</span></div>
          <div><span className="text-gray-500 dark:text-gray-400">Tool calls:</span> <span className="font-medium text-gray-800 dark:text-gray-200">{session.toolCallCount}</span></div>
          <div><span className="text-gray-500 dark:text-gray-400">Guard:</span> <span className="font-medium text-gray-800 dark:text-gray-200">{session.guardDecisionCount}</span></div>
          <div><span className="text-gray-500 dark:text-gray-400">Compactions:</span> <span className="font-medium text-gray-800 dark:text-gray-200">{session.compactionCount}</span></div>
        </div>
        <MiniStats
          cost={cost}
          cache={cache}
          guard={guard}
          compaction={compaction}
        />
      </div>

      {/* Turns list */}
      <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-4">
        <TurnList
          baseUrl={baseUrl}
          sessionId={sessionId}
          onSelect={onSelectTurn}
        />
      </div>
    </div>
  );
}
