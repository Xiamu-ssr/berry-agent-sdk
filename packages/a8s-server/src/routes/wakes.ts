// ============================================================
// Routes: wakes (schedule + operator list/cancel)
// ============================================================

import {
  A8S_PATHS,
  operatorWakeListResponseSchema,
  operatorWakeSchema,
  scheduleWakeRequestSchema,
  scheduleWakeResponseSchema,
} from '@berry-agent/cluster-protocol';
import { readJsonBody, writeJson } from '../http-helpers.js';
import { httpError, type RouteDefinition } from '../router.js';
import type { ServerDeps } from '../deps.js';
import { requireAdminToken } from '../auth.js';
import { withAudit } from '../middleware.js';

export function wakeRoutes<TEntry>(deps: ServerDeps<TEntry>): RouteDefinition[] {
  return [
    {
      method: 'POST',
      pattern: A8S_PATHS.wakesSchedule,
      name: 'POST /v1/wakes/schedule',
      middleware: [
        requireAdminToken(deps),
        withAudit(deps.audit, {
          action: 'wake.schedule',
        }),
      ],
      handler: async ({ req, res }) => {
        const body = await readJsonBody(req);
        const parsed = scheduleWakeRequestSchema.parse(body);
        const wake = await deps.plane.scheduleWake(parsed);
        writeJson(res, 200, scheduleWakeResponseSchema.parse({
          wakeId: wake.wakeId,
          dueAt: wake.dueAt,
        }));
      },
    },
    {
      method: 'GET',
      pattern: A8S_PATHS.operatorWakes,
      name: 'GET /v1/operator/wakes',
      middleware: [requireAdminToken(deps)],
      handler: async ({ res }) => {
        // Pull every pending wake within a 100-year window — effectively
        // "everything". Non-pending wakes (completed/failed/cancelled)
        // appear via the same store: orchestrator.listPendingWakes uses
        // dueAt only as the upper time bound, returns whatever's stored.
        const all = await deps.plane.orchestrator.listPendingWakes(Date.now() + 100 * 365 * 24 * 3600_000);
        const wakes = all.map((w) => operatorWakeSchema.parse({
          wakeId: w.wakeId,
          agentId: w.agentId,
          reason: w.reason,
          state: w.state,
          createdAt: w.createdAt,
          dueAt: w.dueAt,
          claimedAt: w.claimedAt,
          completedAt: w.completedAt,
          failedAt: w.failedAt,
          cancelledAt: w.cancelledAt,
          errorMessage: w.errorMessage,
          sessionId: w.sessionId,
        }));
        writeJson(res, 200, operatorWakeListResponseSchema.parse({ wakes }));
      },
    },
    {
      method: 'DELETE',
      pattern: '/v1/operator/wakes/:wakeId',
      name: 'DELETE /v1/operator/wakes/:id',
      middleware: [
        requireAdminToken(deps),
        withAudit(deps.audit, {
          action: 'wake.cancel',
          target: (ctx) => ctx.params.wakeId,
        }),
      ],
      handler: async ({ params, res }) => {
        const cancelled = await deps.plane.orchestrator.cancelWake(params.wakeId);
        if (!cancelled) {
          throw httpError(404, 'unknown_wake', `wake "${params.wakeId}" not found`);
        }
        writeJson(res, 200, { ok: true });
      },
    },
  ];
}
