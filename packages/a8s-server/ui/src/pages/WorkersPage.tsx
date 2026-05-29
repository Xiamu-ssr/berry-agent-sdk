import { useState } from 'react';
import { useWorkers, useWorkerAction, useJoinScript } from '../api/queries.js';
import { PageHeader, ErrorBanner, Spinner, EmptyState } from '../components/Page.js';
import { StatusPill, relativeTime } from '../components/StatusPill.js';

export function WorkersPage() {
  const workers = useWorkers();
  const drain = useWorkerAction('drain');
  const undrain = useWorkerAction('undrain');
  const evict = useWorkerAction('evict');
  const joinScript = useJoinScript();
  const [scriptModal, setScriptModal] = useState<string | null>(null);

  if (workers.error) return <ErrorBanner error={workers.error} />;
  if (!workers.data) return <Spinner />;

  return (
    <div className="animate-fade-in">
      <PageHeader
        title="Workers"
        subtitle={`${workers.data.length} registered · auto-refresh 5s`}
        actions={
          <button
            type="button"
            className="btn btn-primary"
            onClick={async () => {
              const res = await joinScript.mutateAsync({});
              setScriptModal(res.script);
            }}
            disabled={joinScript.isPending}
          >
            Generate join script
          </button>
        }
      />

      {workers.data.length === 0 ? (
        <EmptyState
          icon="◌"
          title="No workers registered yet"
          hint="Click “Generate join script” and paste the snippet on a new host to add capacity."
        />
      ) : (
        <div className="card overflow-hidden p-0">
          <table className="w-full">
            <thead>
              <tr>
                <th className="table-head">Worker</th>
                <th className="table-head">State</th>
                <th className="table-head">Capacity</th>
                <th className="table-head">Machine</th>
                <th className="table-head">Heartbeat</th>
                <th className="table-head" />
              </tr>
            </thead>
            <tbody>
              {workers.data.map((w) => (
                <tr key={w.workerId} className="hover:bg-ink-50 dark:hover:bg-ink-900/50">
                  <td className="table-cell font-mono text-xs">{w.workerId}</td>
                  <td className="table-cell"><StatusPill state={w.state} /></td>
                  <td className="table-cell tabular-nums">
                    <span className="font-medium">{w.used}</span>
                    <span className="text-ink-400 mx-1">/</span>
                    {w.capacity}
                  </td>
                  <td className="table-cell text-ink-500 dark:text-ink-400 font-mono text-xs">
                    {w.labels?.machine ?? '—'}
                  </td>
                  <td className="table-cell text-ink-500 dark:text-ink-400 text-xs">
                    {relativeTime(w.heartbeatAt)}
                  </td>
                  <td className="table-cell text-right">
                    <div className="flex justify-end gap-1.5">
                      {w.state === 'active' && (
                        <button className="btn btn-default" onClick={() => drain.mutate(w.workerId)}>
                          Drain
                        </button>
                      )}
                      {w.state === 'draining' && (
                        <button className="btn btn-default" onClick={() => undrain.mutate(w.workerId)}>
                          Undrain
                        </button>
                      )}
                      <button
                        className="btn btn-danger"
                        onClick={() => {
                          if (confirm(`Evict ${w.workerId}? Its agents will be released and need re-scheduling.`)) {
                            evict.mutate(w.workerId);
                          }
                        }}
                      >
                        Evict
                      </button>
                    </div>
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

function JoinScriptModal({ script, onClose }: { script: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="fixed inset-0 bg-black/40 dark:bg-black/60 flex items-center justify-center p-4 z-20">
      <div className="card w-full max-w-3xl max-h-[80vh] flex flex-col">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-semibold">Worker join script</h2>
          <button className="btn btn-ghost" onClick={onClose}>✕</button>
        </div>
        <p className="text-sm text-ink-500 dark:text-ink-400 mb-3">
          Paste this in an SSH session on the new host. <strong className="text-berry-600 dark:text-berry-400">It contains the cluster admin token — never share publicly.</strong>
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
