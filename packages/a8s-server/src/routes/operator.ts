// ============================================================
// Routes: operator (cluster, leases — workers/wakes live in their own modules)
// ============================================================

import {
  A8S_PATHS,
  operatorClusterReportSchema,
  operatorLeaseListResponseSchema,
  operatorLeaseSchema,
} from '@berry-agent/cluster-protocol';
import { writeJson } from '../http-helpers.js';
import type { RouteDefinition } from '../router.js';
import type { ServerDeps } from '../deps.js';
import { requireAdminToken } from '../auth.js';

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
  ];
}
