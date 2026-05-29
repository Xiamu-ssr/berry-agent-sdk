import { useMemo, useState } from 'react';
import {
  useAgents,
  useSessions,
  useDeleteAgent,
  useCreateAgent,
  useModelsTemplate,
  useWorkers,
  useMachines,
} from '../api/queries.js';
import { PageHeader, ErrorBanner, Spinner, EmptyState } from '../components/Page.js';
import { relativeTime } from '../components/StatusPill.js';
import { EventStream } from '../components/EventStream.js';

export function AgentsPage() {
  const agents = useAgents();
  const del = useDeleteAgent();
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const [selectedSession, setSelectedSession] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const sessions = useSessions(selectedAgent);

  if (agents.error) return <ErrorBanner error={agents.error} />;
  if (!agents.data) return <Spinner />;

  return (
    <div className="animate-fade-in">
      <PageHeader
        title="Agents"
        subtitle={`${agents.data.length} assigned · auto-refresh 5s`}
        actions={
          <button type="button" className="btn btn-primary" onClick={() => setShowCreate(true)}>
            Create agent
          </button>
        }
      />

      {agents.data.length === 0 ? (
        <EmptyState
          icon="◊"
          title="No agents running"
          hint='Click "Create agent" to mount one on the cluster, or create via product code / admin chat.'
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

      {showCreate && (
        <CreateAgentModal
          existingIds={new Set(agents.data.map((a) => a.agentId))}
          onClose={() => setShowCreate(false)}
        />
      )}
    </div>
  );
}

// ============================================================
// Create-agent modal
// ============================================================
// Mirrors the wire spec the a8s POST /v1/agents accepts. Model
// choices come from the operator-configured models template (the
// same one workers pull at register), so we never let the operator
// type a model id that no worker can serve.

function CreateAgentModal({
  existingIds,
  onClose,
}: {
  existingIds: Set<string>;
  onClose: () => void;
}) {
  const template = useModelsTemplate();
  const workers = useWorkers();
  const machines = useMachines();
  const create = useCreateAgent();

  const [agentId, setAgentId] = useState('');
  const [model, setModel] = useState('');
  const [preferredMachine, setPreferredMachine] = useState('');
  const [grantedMachines, setGrantedMachines] = useState<string[]>([]);

  const modelOptions = useMemo(() => {
    if (!template.data?.template) return { tiers: [], models: [] as string[] };
    const t = template.data.template;
    return {
      tiers: Object.keys(t.tiers ?? {}).map((k) => `tier:${k}`),
      models: Object.keys(t.models ?? {}),
    };
  }, [template.data]);

  const machineOptions = useMemo(() => {
    const set = new Set<string>();
    (workers.data ?? []).forEach((w) => {
      const m = w.labels?.machine;
      if (m) set.add(m);
    });
    return Array.from(set).sort();
  }, [workers.data]);

  const idValid = /^[a-zA-Z0-9._-]{1,64}$/.test(agentId);
  const idCollides = existingIds.has(agentId);
  const canSubmit = idValid && !idCollides && model.length > 0 && !create.isPending;

  const noTemplate = template.data && !template.data.template;
  const noWorkers = workers.data && workers.data.filter((w) => w.state === 'active').length === 0;

  return (
    <div className="fixed inset-0 bg-black/40 dark:bg-black/60 flex items-center justify-center p-4 z-20">
      <div className="card w-full max-w-lg">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-semibold">Create agent</h2>
          <button className="btn btn-ghost" onClick={onClose}>✕</button>
        </div>

        {template.isLoading || workers.isLoading ? (
          <Spinner />
        ) : noTemplate ? (
          <div className="text-sm text-berry-700 dark:text-berry-300">
            No models template configured. Open <strong>Settings → Models</strong> first
            so workers know what providers + models to use.
          </div>
        ) : noWorkers ? (
          <div className="text-sm text-berry-700 dark:text-berry-300">
            No active workers. Generate a join script on the <strong>Workers</strong> page
            and add at least one worker before creating an agent.
          </div>
        ) : (
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (!canSubmit) return;
              create.mutate(
                {
                  agentId: agentId.trim(),
                  model: model.trim(),
                  preferredMachine: preferredMachine.trim() || undefined,
                  labels: grantedMachines.length > 0
                    ? { machines: grantedMachines.join(',') }
                    : undefined,
                },
                {
                  onSuccess: () => onClose(),
                },
              );
            }}
          >
            <Field
              label="Agent ID"
              hint="Used as the directory name under /var/berry/agents. Letters, digits, dot, dash, underscore. Max 64 chars."
            >
              <input
                className="input"
                value={agentId}
                onChange={(e) => setAgentId(e.target.value)}
                placeholder="e.g. helper-1"
                autoFocus
              />
              {agentId.length > 0 && !idValid && (
                <FieldError>Only letters, digits, dot, dash, underscore (max 64).</FieldError>
              )}
              {idCollides && <FieldError>An agent with this id already exists.</FieldError>}
            </Field>

            <Field label="Model" hint="Picked from the cluster-wide models template.">
              <select
                className="input"
                value={model}
                onChange={(e) => setModel(e.target.value)}
              >
                <option value="">Select a model…</option>
                {modelOptions.tiers.length > 0 && (
                  <optgroup label="Tiers (recommended)">
                    {modelOptions.tiers.map((t) => (
                      <option key={t} value={t}>{t}</option>
                    ))}
                  </optgroup>
                )}
                {modelOptions.models.length > 0 && (
                  <optgroup label="Models">
                    {modelOptions.models.map((m) => (
                      <option key={m} value={m}>{m}</option>
                    ))}
                  </optgroup>
                )}
              </select>
            </Field>

            <Field
              label="Preferred machine"
              hint="Optional. Scheduler tries this machine first; falls back to default policy."
            >
              <select
                className="input"
                value={preferredMachine}
                onChange={(e) => setPreferredMachine(e.target.value)}
              >
                <option value="">(any)</option>
                {machineOptions.map((m) => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
            </Field>

            <Field
              label="Grant machines"
              hint="Optional. Each selected machine gives this agent a machine_<id>_exec tool to run commands on that host."
            >
              {(machines.data ?? []).filter((m) => m.state === 'active').length === 0 ? (
                <div className="text-xs text-ink-500 dark:text-ink-400">
                  No active machines. Add one on the Machines page.
                </div>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {(machines.data ?? [])
                    .filter((m) => m.state === 'active')
                    .map((m) => {
                      const on = grantedMachines.includes(m.machineId);
                      return (
                        <button
                          type="button"
                          key={m.machineId}
                          className={`pill ${on ? 'pill-success' : 'pill-muted'} cursor-pointer`}
                          onClick={() =>
                            setGrantedMachines((prev) =>
                              on ? prev.filter((x) => x !== m.machineId) : [...prev, m.machineId],
                            )
                          }
                        >
                          {on ? '✓ ' : ''}{m.machineId}
                        </button>
                      );
                    })}
                </div>
              )}
            </Field>

            {create.error && <ErrorBanner error={create.error} />}

            <div className="flex justify-end gap-2 pt-2">
              <button type="button" className="btn btn-ghost" onClick={onClose}>
                Cancel
              </button>
              <button type="submit" className="btn btn-primary" disabled={!canSubmit}>
                {create.isPending ? 'Creating…' : 'Create'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-xs font-semibold uppercase tracking-wider text-ink-500 dark:text-ink-400 mb-1">
        {label}
      </label>
      {children}
      {hint && <div className="text-xs text-ink-500 dark:text-ink-400 mt-1">{hint}</div>}
    </div>
  );
}

function FieldError({ children }: { children: React.ReactNode }) {
  return <div className="text-xs text-berry-600 dark:text-berry-400 mt-1">{children}</div>;
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
