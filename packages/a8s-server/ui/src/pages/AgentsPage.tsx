import { useState } from 'react';
import { useAgents, useSessions, useDeleteAgent } from '../api/queries.js';
import { PageHeader, ErrorBanner, Spinner, EmptyState } from '../components/Page.js';
import { relativeTime } from '../components/StatusPill.js';
import { EventStream } from '../components/EventStream.js';

export function AgentsPage() {
  const agents = useAgents();
  const del = useDeleteAgent();
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const [selectedSession, setSelectedSession] = useState<string | null>(null);
  const sessions = useSessions(selectedAgent);

  if (agents.error) return <ErrorBanner error={agents.error} />;
  if (!agents.data) return <Spinner />;

  return (
    <div className="animate-fade-in">
      <PageHeader title="Agents" subtitle={`${agents.data.length} assigned · auto-refresh 5s`} />

      {agents.data.length === 0 ? (
        <EmptyState
          icon="◊"
          title="No agents running"
          hint="Create an agent through your product, the admin chat, or the API."
        />
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-[1fr_2fr] gap-4">
          <div className="card overflow-hidden p-0">
            <table className="w-full">
              <thead>
                <tr>
                  <th className="table-head">Agent</th>
                  <th className="table-head">Worker</th>
                  <th className="table-head" />
                </tr>
              </thead>
              <tbody>
                {agents.data.map((a) => (
                  <tr
                    key={a.agentId}
                    className={`cursor-pointer ${
                      selectedAgent === a.agentId
                        ? 'bg-berry-50 dark:bg-berry-950/30'
                        : 'hover:bg-ink-50 dark:hover:bg-ink-900/50'
                    }`}
                    onClick={() => {
                      setSelectedAgent(a.agentId);
                      setSelectedSession(null);
                    }}
                  >
                    <td className="table-cell font-mono text-xs">{a.agentId}</td>
                    <td className="table-cell font-mono text-xs text-ink-500 dark:text-ink-400">
                      {a.workerId ?? <span className="text-berry-600">(stranded)</span>}
                    </td>
                    <td className="table-cell text-right">
                      <button
                        className="btn btn-ghost text-xs"
                        onClick={(e) => {
                          e.stopPropagation();
                          if (confirm(`Delete agent "${a.agentId}"? This stops the runtime; on-disk data is preserved.`)) {
                            del.mutate(a.agentId);
                            if (selectedAgent === a.agentId) setSelectedAgent(null);
                          }
                        }}
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div>
            {selectedAgent ? (
              <AgentDetail
                agentId={selectedAgent}
                selectedSession={selectedSession}
                onSelectSession={setSelectedSession}
                sessions={sessions.data ?? []}
                sessionsLoading={sessions.isLoading}
              />
            ) : (
              <EmptyState icon="◊" title="Select an agent" hint="Click a row to inspect its sessions and live events." />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function AgentDetail({
  agentId,
  selectedSession,
  onSelectSession,
  sessions,
  sessionsLoading,
}: {
  agentId: string;
  selectedSession: string | null;
  onSelectSession(id: string | null): void;
  sessions: import('../api/queries.js').SessionSummary[];
  sessionsLoading: boolean;
}) {
  return (
    <div className="space-y-4">
      <div className="card">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-ink-500 dark:text-ink-400 mb-3">
          Sessions
        </h2>
        {sessionsLoading ? (
          <Spinner />
        ) : sessions.length === 0 ? (
          <div className="text-sm text-ink-500 dark:text-ink-400">No sessions yet.</div>
        ) : (
          <ul className="space-y-1">
            {sessions.map((s) => (
              <li key={s.id}>
                <button
                  className={`w-full text-left text-sm px-3 py-2 rounded-md transition-colors ${
                    selectedSession === s.id
                      ? 'bg-berry-50 dark:bg-berry-950/30 text-ink-900 dark:text-ink-100'
                      : 'hover:bg-ink-50 dark:hover:bg-ink-900'
                  }`}
                  onClick={() => onSelectSession(s.id)}
                >
                  <div className="flex items-center justify-between">
                    <code className="font-mono text-xs">{s.id}</code>
                    <span className="pill pill-muted text-[10px]">{s.status}</span>
                  </div>
                  <div className="text-xs text-ink-500 dark:text-ink-400 mt-0.5">
                    {relativeTime(s.lastActiveAt)} · {s.messageCount ?? 0} messages
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {selectedSession && (
        <div className="card">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-ink-500 dark:text-ink-400 mb-3">
            Events (live)
          </h2>
          <EventStream agentId={agentId} sessionId={selectedSession} />
        </div>
      )}
    </div>
  );
}
