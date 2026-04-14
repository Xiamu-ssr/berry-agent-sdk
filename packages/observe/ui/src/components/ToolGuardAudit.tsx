import { Shield, Check, X, Edit } from 'lucide-react';
import { useObserveApi } from '../hooks/useObserve';

interface Props {
  baseUrl: string;
  sessionId?: string;
  agentId?: string;
}

export function ToolGuardAudit({ baseUrl, sessionId }: Props) {
  const params = new URLSearchParams();
  if (sessionId) params.set('sessionId', sessionId);

  const { data: stats } = useObserveApi<any>(baseUrl, `/guard?${sessionId ? `sessionId=${sessionId}` : ''}`);
  const { data: decisions } = useObserveApi<any[]>(baseUrl, `/guard/decisions?${params}`);

  return (
    <div className="space-y-4">
      <h3 className="text-lg font-semibold text-gray-800 flex items-center gap-2">
        <Shield size={18} /> Guard Audit
      </h3>

      {/* Summary stats */}
      {stats && (
        <div className="flex gap-4 text-sm">
          <span className="flex items-center gap-1 text-green-600">
            <Check size={14} /> {stats.allowCount} allowed
          </span>
          <span className="flex items-center gap-1 text-red-600">
            <X size={14} /> {stats.denyCount} denied
          </span>
          <span className="flex items-center gap-1 text-yellow-600">
            <Edit size={14} /> {stats.modifyCount} modified
          </span>
          <span className="text-gray-400">avg {stats.avgDurationMs?.toFixed(1)}ms</span>
        </div>
      )}

      {/* Decision list */}
      {decisions && decisions.length > 0 && (
        <div className="space-y-2">
          {decisions.map((d: any) => (
            <div key={d.id} className={`px-4 py-3 rounded-lg border text-sm ${
              d.decision === 'allow' ? 'bg-green-50 border-green-200' :
              d.decision === 'deny' ? 'bg-red-50 border-red-200' :
              'bg-yellow-50 border-yellow-200'
            }`}>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  {d.decision === 'allow' ? <Check size={16} className="text-green-600" /> :
                   d.decision === 'deny' ? <X size={16} className="text-red-600" /> :
                   <Edit size={16} className="text-yellow-600" />}
                  <span className="font-mono font-medium">{d.toolName}</span>
                  <span className="text-gray-500 uppercase text-xs">{d.decision}</span>
                </div>
                <div className="text-gray-400 text-xs">
                  {d.durationMs}ms · {new Date(d.timestamp).toLocaleTimeString()}
                </div>
              </div>
              {d.reason && <div className="mt-1 text-red-600 text-xs">Reason: {d.reason}</div>}
              <div className="mt-1 text-xs font-mono text-gray-500 truncate">Input: {d.input}</div>
            </div>
          ))}
        </div>
      )}

      {(!decisions || decisions.length === 0) && (
        <div className="text-gray-400 text-sm p-4">No guard decisions recorded</div>
      )}
    </div>
  );
}
