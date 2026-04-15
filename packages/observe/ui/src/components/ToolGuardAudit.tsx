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
      <h3 className="text-lg font-semibold text-gray-800 dark:text-gray-100 flex items-center gap-2">
        <Shield size={18} /> Guard Audit
      </h3>

      {/* Summary stats */}
      {stats && (
        <div className="flex gap-4 text-sm">
          <span className="flex items-center gap-1 text-green-600 dark:text-green-400">
            <Check size={14} /> {stats.allowCount} allowed
          </span>
          <span className="flex items-center gap-1 text-red-600 dark:text-red-400">
            <X size={14} /> {stats.denyCount} denied
          </span>
          <span className="flex items-center gap-1 text-yellow-600 dark:text-yellow-400">
            <Edit size={14} /> {stats.modifyCount} modified
          </span>
          <span className="text-gray-400 dark:text-gray-500">avg {stats.avgDurationMs?.toFixed(1)}ms</span>
        </div>
      )}

      {/* Tabs */}
      <div className="flex gap-1 border-b border-gray-200 dark:border-gray-700">
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
              <span className="text-gray-500 dark:text-gray-400">Filtered by tool:</span>
              <span className="font-mono bg-gray-100 dark:bg-gray-700 px-2 py-0.5 rounded text-gray-700 dark:text-gray-300">{filterTool}</span>
              <button onClick={() => setFilterTool(undefined)} className="text-red-400 hover:text-red-600 dark:text-red-500 dark:hover:text-red-400 text-xs">✕ clear</button>
            </div>
          )}

          {/* Decision list */}
          {decisions && decisions.length > 0 ? (
            <div className="space-y-2">
              {decisions.map((d: any) => (
                <div key={d.id} className={`px-4 py-3 rounded-lg border text-sm ${
                  d.decision === 'allow' ? 'bg-green-50 dark:bg-green-900/20 border-green-200 dark:border-green-800' :
                  d.decision === 'deny' ? 'bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-800' :
                  'bg-yellow-50 dark:bg-yellow-900/20 border-yellow-200 dark:border-yellow-800'
                }`}>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      {d.decision === 'allow' ? <Check size={16} className="text-green-600 dark:text-green-400" /> :
                       d.decision === 'deny' ? <X size={16} className="text-red-600 dark:text-red-400" /> :
                       <Edit size={16} className="text-yellow-600 dark:text-yellow-400" />}
                      <button
                        className="font-mono font-medium hover:text-indigo-600 dark:hover:text-indigo-400 hover:underline text-gray-800 dark:text-gray-200"
                        onClick={() => setFilterTool(d.toolName)}
                      >
                        {d.toolName}
                      </button>
                      <span className="text-gray-500 dark:text-gray-400 uppercase text-xs">{d.decision}</span>
                    </div>
                    <div className="text-gray-400 dark:text-gray-500 text-xs">
                      {d.durationMs}ms · {new Date(d.timestamp).toLocaleTimeString()}
                    </div>
                  </div>
                  {d.reason && <div className="mt-1 text-red-600 dark:text-red-400 text-xs">Reason: {d.reason}</div>}
                  <div className="mt-1 text-xs font-mono text-gray-500 dark:text-gray-400 truncate">Input: {d.input}</div>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-gray-400 dark:text-gray-500 text-sm p-4">No guard decisions recorded</div>
          )}
        </>
      )}

      {tab === 'by-tool' && (
        <>
          {byTool && byTool.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-200 dark:border-gray-700 text-left">
                    <th className="pb-2 font-medium text-gray-600 dark:text-gray-300">Tool</th>
                    <th className="pb-2 font-medium text-gray-600 dark:text-gray-300 text-right">Allow</th>
                    <th className="pb-2 font-medium text-gray-600 dark:text-gray-300 text-right">Deny</th>
                    <th className="pb-2 font-medium text-gray-600 dark:text-gray-300 text-right">Modify</th>
                    <th className="pb-2 font-medium text-gray-600 dark:text-gray-300 text-right">Total</th>
                    <th className="pb-2 font-medium text-gray-600 dark:text-gray-300 text-right">Deny Rate</th>
                  </tr>
                </thead>
                <tbody>
                  {byTool.map((row: any) => (
                    <tr key={row.toolName} className="border-b border-gray-100 dark:border-gray-800 hover:bg-gray-50 dark:hover:bg-gray-700/50">
                      <td className="py-2">
                        <button
                          className="font-mono text-indigo-600 dark:text-indigo-400 hover:underline"
                          onClick={() => { setTab('decisions'); setFilterTool(row.toolName); }}
                        >
                          {row.toolName}
                        </button>
                      </td>
                      <td className="py-2 text-right text-green-600 dark:text-green-400">{row.allowCount}</td>
                      <td className="py-2 text-right text-red-600 dark:text-red-400">{row.denyCount}</td>
                      <td className="py-2 text-right text-yellow-600 dark:text-yellow-400">{row.modifyCount}</td>
                      <td className="py-2 text-right text-gray-600 dark:text-gray-300">{row.totalCount}</td>
                      <td className="py-2 text-right">
                        <span className={`px-2 py-0.5 rounded text-xs font-medium ${
                          row.denyRate > 0.5 ? 'bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-400' :
                          row.denyRate > 0 ? 'bg-yellow-100 dark:bg-yellow-900/40 text-yellow-700 dark:text-yellow-400' :
                          'bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-400'
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
            <div className="text-gray-400 dark:text-gray-500 text-sm p-4">No guard decisions recorded</div>
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
        active ? 'border-indigo-500 text-indigo-600 dark:text-indigo-400' : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300'
      }`}
    >
      {children}
    </button>
  );
}
