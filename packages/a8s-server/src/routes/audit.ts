// ============================================================
// Routes: Audit log query — 甲2 P3
// ============================================================
//
// The read side of the append-only audit log (audit.ts writes it). The
// operator's Audit page calls this to review who did what, when, and the
// outcome. Read-only, so no withAudit wrapper (we don't audit reads of the
// audit log). Admin-token guarded like every operator route.
//
// Query params: from/to (Unix ms), action (exact verb), outcome (ok|err),
// limit (1–2000, default 200). The store reads the per-day JSONL files in
// range, newest first, and reports `truncated` if it hit the cap.

import {
  A8S_PATHS,
  auditQueryResponseSchema,
} from '@berry-agent/cluster-protocol';
import { writeJson } from '../http-helpers.js';
import type { RouteDefinition } from '../router.js';
import type { ServerDeps } from '../deps.js';
import { requireAdminToken } from '../auth.js';

function intParam(query: URLSearchParams, key: string): number | undefined {
  const raw = query.get(key);
  if (raw == null || raw === '') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

export function auditRoutes<TEntry>(deps: ServerDeps<TEntry>): RouteDefinition[] {
  return [
    {
      method: 'GET',
      pattern: A8S_PATHS.operatorAudit,
      name: 'GET /v1/operator/audit',
      middleware: [requireAdminToken(deps)],
      handler: async ({ res, query }) => {
        const outcomeRaw = query.get('outcome');
        const outcome = outcomeRaw === 'ok' || outcomeRaw === 'err' ? outcomeRaw : undefined;
        const { entries, truncated } = await deps.audit.query({
          from: intParam(query, 'from'),
          to: intParam(query, 'to'),
          action: query.get('action') || undefined,
          outcome,
          limit: intParam(query, 'limit'),
        });
        writeJson(res, 200, auditQueryResponseSchema.parse({ entries, truncated }));
      },
    },
  ];
}
