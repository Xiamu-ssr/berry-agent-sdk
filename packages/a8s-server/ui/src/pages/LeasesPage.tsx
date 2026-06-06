import { useLeases } from '../api/queries.js';
import { PageHeader, ErrorBanner, Spinner, EmptyState } from '../components/Page.js';
import { relativeTime } from '../components/StatusPill.js';

const LEASE_PILL: Record<string, string> = {
  active: 'pill pill-success',
  released: 'pill pill-muted',
  expired: 'pill pill-danger',
};

export function LeasesPage() {
  const leases = useLeases();

  if (leases.error) return <ErrorBanner error={leases.error} />;
  if (!leases.data) return <Spinner />;

  return (
    <div className="animate-fade-in">
      <PageHeader
        title="Leases"
        subtitle={`${leases.data.length} runtime lease(s) · auto-refresh 10s`}
      />

      {leases.data.length === 0 ? (
        <EmptyState
          icon="📄"
          title="No leases"
          hint="A lease is held while an agent is mounted on a worker. None are active right now."
        />
      ) : (
        <div className="card overflow-hidden p-0">
          <table className="w-full">
            <thead>
              <tr>
                <th className="table-head">Lease</th>
                <th className="table-head">Agent</th>
                <th className="table-head">Worker</th>
                <th className="table-head">State</th>
                <th className="table-head">Acquired</th>
                <th className="table-head">Expires</th>
              </tr>
            </thead>
            <tbody>
              {leases.data.map((l) => (
                <tr key={l.leaseId} className="hover:bg-ink-50 dark:hover:bg-ink-900/50">
                  <td className="table-cell font-mono text-xs">{l.leaseId.slice(0, 16)}</td>
                  <td className="table-cell font-mono text-xs">{l.agentId}</td>
                  <td className="table-cell font-mono text-xs text-ink-500 dark:text-ink-400">
                    {l.workerId ?? '—'}
                  </td>
                  <td className="table-cell">
                    <span className={LEASE_PILL[l.state] ?? 'pill pill-muted'}>{l.state}</span>
                  </td>
                  <td className="table-cell text-ink-500 dark:text-ink-400 text-xs">{relativeTime(l.acquiredAt)}</td>
                  <td className="table-cell text-ink-500 dark:text-ink-400 text-xs">{relativeTime(l.expiresAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
