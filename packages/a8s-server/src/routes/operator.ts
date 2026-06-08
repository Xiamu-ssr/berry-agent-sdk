// ============================================================
// Routes: operator (cluster, leases — workers/wakes live in their own modules)
// ============================================================

import {
  A8S_PATHS,
  adminAgentEnsureRequestSchema,
  adminAgentStatusResponseSchema,
  operatorClusterReportSchema,
  operatorLeaseListResponseSchema,
  operatorLeaseSchema,
} from '@berry-agent/cluster-protocol';
import { readJsonBody, writeJson } from '../http-helpers.js';
import type { RouteDefinition } from '../router.js';
import type { ServerDeps } from '../deps.js';
import { requireAdminToken } from '../auth.js';
import { withAudit } from '../middleware.js';
import { ensureAdminAgent } from '../bootstrap.js';

const ADMIN_AGENT_ID = 'berry-admin';

export function operatorRoutes<TEntry>(deps: ServerDeps<TEntry>): RouteDefinition[] {
  return [
    {
      method: 'GET',
      pattern: A8S_PATHS.operatorCluster,
      name: 'GET /v1/operator/cluster',
      middleware: [requireAdminToken(deps)],
      handler: async ({ res }) => {
        const workers = await deps.plane.orchestrator.listWorkers();
        let capacityTotal = 0;
        let active = 0, draining = 0, evicted = 0;
        for (const w of workers) {
          if (w.state === 'active') { active++; capacityTotal += w.capacity; }
          else if (w.state === 'draining') { draining++; capacityTotal += w.capacity; }
          else if (w.state === 'evicted' || w.state === 'withdrawn') evicted++;
        }
        const agents = deps.plane.listAgents();
        const usedTotal = agents.length;

        // Update metrics gauges so /metrics has fresh values without
        // needing a dedicated update path.
        deps.metrics.workersTotal.set(active, { state: 'active' });
        deps.metrics.workersTotal.set(draining, { state: 'draining' });
        deps.metrics.workersTotal.set(evicted, { state: 'evicted' });
        deps.metrics.agentsTotal.set(agents.length);

        const report = operatorClusterReportSchema.parse({
          workerCount: { total: workers.length, active, draining, evicted },
          capacity: {
            total: capacityTotal,
            used: usedTotal,
            available: Math.max(0, capacityTotal - usedTotal),
          },
          agentCount: agents.length,
          uptimeSeconds: Math.floor((Date.now() - deps.startedAt) / 1000),
        });
        writeJson(res, 200, report);
      },
    },
    {
      method: 'GET',
      pattern: A8S_PATHS.operatorLeases,
      name: 'GET /v1/operator/leases',
      middleware: [requireAdminToken(deps)],
      handler: async ({ res }) => {
        const leases = await deps.plane.orchestrator.listLeases();
        const list = leases.map((l) => operatorLeaseSchema.parse({
          leaseId: l.leaseId,
          agentId: l.agentId,
          holderId: l.holderId,
          workerId: l.workerId,
          state: l.state,
          acquiredAt: l.acquiredAt,
          renewedAt: l.renewedAt,
          expiresAt: l.expiresAt,
          releasedAt: l.releasedAt,
          sessionId: l.sessionId,
        }));
        writeJson(res, 200, operatorLeaseListResponseSchema.parse({ leases: list }));
      },
    },
    {
      method: 'GET',
      pattern: A8S_PATHS.operatorAdminAgent,
      name: 'GET /v1/operator/admin-agent',
      middleware: [requireAdminToken(deps)],
      handler: ({ res }) => {
        const loc = deps.plane.getAgentLocation(ADMIN_AGENT_ID);
        writeJson(res, 200, adminAgentStatusResponseSchema.parse({
          agentId: ADMIN_AGENT_ID,
          present: loc.workerId != null,
          workerId: loc.workerId ?? null,
        }));
      },
    },
    {
      method: 'POST',
      pattern: A8S_PATHS.operatorAdminAgent,
      name: 'POST /v1/operator/admin-agent',
      middleware: [
        requireAdminToken(deps),
        withAudit(deps.audit, { action: 'admin_agent.ensure', target: () => ADMIN_AGENT_ID }),
      ],
      handler: async ({ req, res }) => {
        // Idempotent: schedules berry-admin onto an active worker if it
        // isn't already running. The worker injects the cluster-admin
        // tools + seeds AGENTS.md via its resolveSpec (label-driven).
        // The admin agent goes through the normal config path — the operator
        // may pick its model + classifier; omitted fields fall back to defaults.
        const body = adminAgentEnsureRequestSchema.parse((await readJsonBody(req)) ?? {});
        await ensureAdminAgent(deps.plane, {
          ...(body.model ? { model: body.model } : {}),
          ...(body.classifierModel ? { classifierModel: body.classifierModel } : {}),
        });
        const loc = deps.plane.getAgentLocation(ADMIN_AGENT_ID);
        writeJson(res, 200, adminAgentStatusResponseSchema.parse({
          agentId: ADMIN_AGENT_ID,
          present: loc.workerId != null,
          workerId: loc.workerId ?? null,
        }));
      },
    },
  ];
}
