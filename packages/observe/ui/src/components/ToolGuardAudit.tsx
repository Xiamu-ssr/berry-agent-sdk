import { useState } from 'react';
import { Shield, Check, X, Edit, BarChart2 } from 'lucide-react';
import { useObserveApi } from '../hooks/useObserve';

interface Props {
  baseUrl: string;
  sessionId?: string;
  agentId?: string;
  turnId?: string;
}

type Tab = 'decisions' | 'by-tool';

export function ToolGuardAudit({ baseUrl, sessionId, agentId, turnId }: Props) {
  const [tab, setTab] = useState<Tab>('decisions');
  const [filterTool, setFilterTool] = useState<string | undefined>();

  const dimParams = new URLSearchParams();
  if (sessionId) dimParams.set('sessionId', sessionId);
  if (agentId) dimParams.set('agentId', agentId);
  if (turnId) dimParams.set('turnId', turnId);

  const decisionParams = new URLSearchParams(dimParams);
  if (filterTool) decisionParams.set('toolName', filterTool);

  const { data: stats } = useObserveApi<any>(baseUrl, `/guard?${dimParams}`);
  const { data: decisions } = useObserveApi<any[]>(baseUrl, `/guard/decisions?${decisionParams}`);
  const { data: byTool } = useObserveApi<any[]>(baseUrl, `/guard/by-tool?${dimParams}`);

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

      {/* Tabs */}
      <div className="flex gap-1 border-b border-gray-200">
        <TabBtn active={tab === 'decisions'} onClick={() => { setTab('decisions'); setFilterTool(undefined); }}>
          Decisions
        </TabBtn>
        <TabBtn active={tab === 'by-tool'} onClick={() => setTab('by-tool')}>
          <BarChart2 size={14} className="inline mr-1" />By Tool
        </TabBtn>
      </div>

      {tab === 'decisions' && (
        <>
          {filterTool && (
            <div className="flex items-center gap-2 text-sm">
              <span className="text-gray-500">Filtered by tool:</span>
              <span className="font-mono bg-gray-100 px-2 py-0.5 rounded">{filterTool}</span>
              <button onClick={() => setFilterTool(undefined)} className="text-red-400 hover:text-red-600 text-xs">✕ clear</button>
            </div>
          )}

          {/* Decision list */}
          {decisions && decisions.length > 0 ? (
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
                      <button
                        className="font-mono font-medium hover:text-indigo-600 hover:underline"
                        onClick={() => setFilterTool(d.toolName)}
                      >
                        {d.toolName}
                      </button>
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
          ) : (
            <div className="text-gray-400 text-sm p-4">No guard decisions recorded</div>
          )}
        </>
      )}

      {tab === 'by-tool' && (
        <>
          {byTool && byTool.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-200 text-left">
                    <th className="pb-2 font-medium text-gray-600">Tool</th>
                    <th className="pb-2 font-medium text-gray-600 text-right">Allow</th>
                    <th className="pb-2 font-medium text-gray-600 text-right">Deny</th>
                    <th className="pb-2 font-medium text-gray-600 text-right">Modify</th>
                    <th className="pb-2 font-medium text-gray-600 text-right">Total</th>
                    <th className="pb-2 font-medium text-gray-600 text-right">Deny Rate</th>
                  </tr>
                </thead>
                <tbody>
                  {byTool.map((row: any) => (
                    <tr key={row.toolName} className="border-b border-gray-100 hover:bg-gray-50">
                      <td className="py-2">
                        <button
                          className="font-mono text-indigo-600 hover:underline"
                          onClick={() => { setTab('decisions'); setFilterTool(row.toolName); }}
                        >
                          {row.toolName}
                        </button>
                      </td>
                      <td className="py-2 text-right text-green-600">{row.allowCount}</td>
                      <td className="py-2 text-right text-red-600">{row.denyCount}</td>
                      <td className="py-2 text-right text-yellow-600">{row.modifyCount}</td>
                      <td className="py-2 text-right text-gray-600">{row.totalCount}</td>
                      <td className="py-2 text-right">
                        <span className={`px-2 py-0.5 rounded text-xs font-medium ${
                          row.denyRate > 0.5 ? 'bg-red-100 text-red-700' :
                          row.denyRate > 0 ? 'bg-yellow-100 text-yellow-700' :
                          'bg-green-100 text-green-700'
                        }`}>
                          {(row.denyRate * 100).toFixed(1)}%
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="text-gray-400 text-sm p-4">No guard decisions recorded</div>
          )}
        </>
      )}
    </div>
  );
}

function TabBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
        active ? 'border-indigo-500 text-indigo-600' : 'border-transparent text-gray-500 hover:text-gray-700'
      }`}
    >
      {children}
    </button>
  );
}
