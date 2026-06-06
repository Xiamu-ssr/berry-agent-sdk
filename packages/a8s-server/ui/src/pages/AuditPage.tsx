import { PageHeader, EmptyState } from '../components/Page.js';

/**
 * Audit log — operator actions (who did what, when, outcome).
 *
 * a8s already appends audit entries to audit.YYYY-MM-DD.jsonl, but there is
 * no query endpoint yet (P3). This page is the placeholder; it becomes a
 * filterable table once GET /v1/operator/audit lands.
 */
export function AuditPage() {
  return (
    <div className="animate-fade-in">
      <PageHeader
        title="Audit log"
        subtitle="Operator actions — who did what, when, and the outcome"
      />
      <EmptyState
        icon="📋"
        title="Audit viewing is coming"
        hint="a8s already records every operator action to an append-only log; the query endpoint (GET /v1/operator/audit) is being wired."
      />
    </div>
  );
}
