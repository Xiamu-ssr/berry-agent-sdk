import { ArrowLeft, MessageSquare } from 'lucide-react';
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

  if (loading) return <div className="p-4 text-gray-400">Loading...</div>;
  if (!data) return <div className="p-4 text-gray-400">Turn not found</div>;

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center gap-3">
        {onBack && (
          <button onClick={onBack} className="p-1 hover:bg-gray-100 rounded">
            <ArrowLeft size={20} />
          </button>
        )}
        <div>
          <h3 className="text-lg font-bold text-gray-800 flex items-center gap-2">
            <MessageSquare size={18} /> Turn Detail
          </h3>
          <div className="text-xs font-mono text-gray-400">{turnId}</div>
        </div>
        <span className={`ml-2 px-2 py-0.5 rounded text-xs ${
          data.status === 'completed' ? 'bg-green-100 text-green-700' : 'bg-yellow-100 text-yellow-700'
        }`}>{data.status}</span>
      </div>

      {/* Prompt */}
      {data.prompt && (
        <div className="bg-blue-50 border border-blue-200 rounded-lg px-4 py-3 text-sm text-gray-700">
          <div className="text-xs font-medium text-blue-500 mb-1">User Prompt</div>
          <div className="whitespace-pre-wrap break-words">{data.prompt}</div>
        </div>
      )}

      {/* Stats banner */}
      <div className="bg-white rounded-xl border border-gray-200 p-4">
        <h4 className="text-sm font-semibold text-gray-600 mb-3">Stats</h4>
        <div className="flex flex-wrap gap-4 text-sm mb-3">
          <div><span className="text-gray-500">Start:</span> <span>{new Date(data.startTime).toLocaleString()}</span></div>
          {data.endTime && (
            <div><span className="text-gray-500">Duration:</span> <span>{((data.endTime - data.startTime) / 1000).toFixed(2)}s</span></div>
          )}
          <div><span className="text-gray-500">API calls:</span> <span className="font-medium">{data.llmCallCount}</span></div>
          <div><span className="text-gray-500">Tool calls:</span> <span className="font-medium">{data.toolCallCount}</span></div>
        </div>
        <MiniStats
          cost={data.cost}
          cache={data.cache}
          guard={data.guard}
        />
      </div>

      {/* Inferences for this turn */}
      <div className="bg-white rounded-xl border border-gray-200 p-4">
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
