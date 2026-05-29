import { useWakes, useCancelWake } from '../api/queries.js';
import { PageHeader, ErrorBanner, Spinner, EmptyState } from '../components/Page.js';
import { WakeStatePill, relativeTime } from '../components/StatusPill.js';

export function WakesPage() {
  const wakes = useWakes();
  const cancel = useCancelWake();

  if (wakes.error) return <ErrorBanner error={wakes.error} />;
  if (!wakes.data) return <Spinner />;

  return (
    <div className="animate-fade-in">
      <PageHeader title="Wake queue" subtitle={`${wakes.data.length} scheduled · auto-refresh 5s`} />

      {wakes.data.length === 0 ? (
        <EmptyState icon="⏰" title="No wakes scheduled" hint="Wakes fire when products call POST /v1/wakes/schedule." />
      ) : (
        <div className="card overflow-hidden p-0">
          <table className="w-full">
            <thead>
              <tr>
                <th className="table-head">Wake</th>
                <th className="table-head">Agent</th>
                <th className="table-head">Reason</th>
                <th className="table-head">State</th>
                <th className="table-head">Due</th>
                <th className="table-head" />
              </tr>
            </thead>
            <tbody>
              {wakes.data.map((w) => (
                <tr key={w.wakeId} className="hover:bg-ink-50 dark:hover:bg-ink-900/50">
                  <td className="table-cell font-mono text-xs">{w.wakeId.slice(0, 16)}</td>
                  <td className="table-cell font-mono text-xs">{w.agentId}</td>
                  <td className="table-cell">{w.reason}</td>
                  <td className="table-cell"><WakeStatePill state={w.state} /></td>
                  <td className="table-cell text-ink-500 dark:text-ink-400 text-xs">{relativeTime(w.dueAt)}</td>
                  <td className="table-cell text-right">
                    {w.state === 'pending' && (
                      <button
                        className="btn btn-default"
                        onClick={() => {
                          if (confirm(`Cancel wake ${w.wakeId.slice(0, 12)}…?`)) cancel.mutate(w.wakeId);
                        }}
                      >
                        Cancel
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
