import { useState } from 'react';
import { useMachines, useMachineJoinScript, type Machine } from '../api/queries.js';
import { PageHeader, ErrorBanner, Spinner, EmptyState } from '../components/Page.js';
import { relativeTime } from '../components/StatusPill.js';

export function MachinesPage() {
  const machines = useMachines();
  const joinScript = useMachineJoinScript();
  const [scriptModal, setScriptModal] = useState<string | null>(null);

  if (machines.error) return <ErrorBanner error={machines.error} />;
  if (!machines.data) return <Spinner />;

  return (
    <div className="animate-fade-in">
      <PageHeader
        title="Machines"
        subtitle={`${machines.data.length} registered · auto-refresh 5s`}
        actions={
          <button
            type="button"
            className="btn btn-primary"
            disabled={joinScript.isPending}
            onClick={async () => {
              const res = await joinScript.mutateAsync({});
              setScriptModal(res.script);
            }}
          >
            Add machine
          </button>
        }
      />

      <p className="text-sm text-ink-500 dark:text-ink-400 -mt-3 mb-4 max-w-3xl">
        A machine lends an execution surface to the cluster — agents granted it (via the
        <code className="font-mono text-xs mx-1">machines</code> label on Create agent) get a
        <code className="font-mono text-xs mx-1">machine_&lt;id&gt;_exec</code> tool to run commands on it.
        Unlike a worker, a machine runs no agent brains. Install a connector on a host with “Add machine”.
      </p>

      {machines.data.length === 0 ? (
        <EmptyState
          icon="🖐"
          title="No machines registered"
          hint='Click “Add machine” and run the snippet on a host you want an agent to operate (e.g. install a worker on it).'
        />
      ) : (
        <div className="card overflow-hidden p-0">
          <table className="w-full">
            <thead>
              <tr>
                <th className="table-head">Machine</th>
                <th className="table-head">State</th>
                <th className="table-head">Platform</th>
                <th className="table-head">MCP</th>
                <th className="table-head">Heartbeat</th>
              </tr>
            </thead>
            <tbody>
              {machines.data.map((m) => (
                <tr key={m.machineId} className="hover:bg-ink-50 dark:hover:bg-ink-900/50">
                  <td className="table-cell font-mono text-xs">{m.machineId}</td>
                  <td className="table-cell"><MachineState state={m.state} /></td>
                  <td className="table-cell text-ink-500 dark:text-ink-400 text-xs">{m.platform ?? '—'}</td>
                  <td className="table-cell text-ink-500 dark:text-ink-400 text-xs">
                    {m.mcpServers.length > 0 ? m.mcpServers.join(', ') : '—'}
                  </td>
                  <td className="table-cell text-ink-500 dark:text-ink-400 text-xs">
                    {relativeTime(m.heartbeatAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {scriptModal && <JoinScriptModal script={scriptModal} onClose={() => setScriptModal(null)} />}
    </div>
  );
}

function MachineState({ state }: { state: Machine['state'] }) {
  const cls = state === 'active'
    ? 'pill pill-success'
    : state === 'expired'
      ? 'pill pill-warn'
      : 'pill pill-muted';
  return <span className={cls}>{state}</span>;
}

function JoinScriptModal({ script, onClose }: { script: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="fixed inset-0 bg-black/40 dark:bg-black/60 flex items-center justify-center p-4 z-20">
      <div className="card w-full max-w-3xl max-h-[80vh] flex flex-col">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-semibold">Machine connector install script</h2>
          <button className="btn btn-ghost" onClick={onClose}>✕</button>
        </div>
        <p className="text-sm text-ink-500 dark:text-ink-400 mb-3">
          Run this on the host you want to add.{' '}
          <strong className="text-berry-600 dark:text-berry-400">
            It contains the cluster admin token — never share publicly.
          </strong>{' '}
          The machine will register and accept commands the cluster sends, so install it only on hosts
          you intend an agent to operate.
        </p>
        <pre className="flex-1 overflow-auto bg-ink-950 text-ink-100 dark:bg-ink-950 p-4 rounded-md text-xs font-mono whitespace-pre-wrap">
          {script}
        </pre>
        <div className="mt-3 flex justify-end gap-2">
          <button
            className="btn btn-primary"
            onClick={async () => {
              await navigator.clipboard.writeText(script);
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            }}
          >
            {copied ? '✓ Copied' : 'Copy to clipboard'}
          </button>
        </div>
      </div>
    </div>
  );
}
