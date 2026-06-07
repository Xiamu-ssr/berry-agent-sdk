// ============================================================
// Routes: usage / consumption (read-only rollup)
// ============================================================
//
// a8s holds NO usage state. Every worker keeps the real numbers in its
// private observe.db (every inference's tokens + cost, rolled up to the
// agent). These two routes surface that:
//
//   GET /v1/agents/:id/usage   — proxy to the agent's owning worker
//   GET /v1/operator/usage     — fan-in over all agents, then aggregate
//                                upward into cluster + per-product totals
//
// "Aggregate upward, never re-record": the agent rollup is the atomic
// unit we fetch; cluster and product totals are pure sums over it.

import {
  A8S_PATHS,
  WORKER_AUTH_HEADER,
  WORKER_PATHS,
  agentUsageResponseSchema,
  operatorUsageResponseSchema,
  workerAuthHeader,
  type AgentUsage,
  type OperatorUsageAgentRow,
} from '@berry-agent/cluster-protocol';
import { writeJson } from '../http-helpers.js';
import { httpError, type RouteDefinition } from '../router.js';
import type { ServerDeps } from '../deps.js';
import { requireAdminToken, requireAgentScope } from '../auth.js';
import { resolveAgentWorker } from './agents.js';

export function usageRoutes<TEntry>(deps: ServerDeps<TEntry>): RouteDefinition[] {
  return [
    {
      method: 'GET',
      pattern: '/v1/agents/:agentId/usage',
      name: 'GET /v1/agents/:id/usage',
      middleware: [requireAgentScope(deps)],
      handler: async ({ params, res }) => {
        const usage = await fetchAgentUsage(deps, params.agentId);
        writeJson(res, 200, agentUsageResponseSchema.parse({
          present: usage !== null,
          usage,
        }));
      },
    },
    {
      method: 'GET',
      pattern: A8S_PATHS.operatorUsage,
      name: 'GET /v1/operator/usage',
      middleware: [requireAdminToken(deps)],
      handler: async ({ res }) => {
        const locations = deps.plane.listAgents();

        // Fan out to each owning worker concurrently; a worker that's gone
        // or has no record contributes nothing rather than failing the whole
        // rollup. Each row carries owner+workerId for the product grouping.
        const rows = (await Promise.all(
          locations.map(async (loc): Promise<OperatorUsageAgentRow | null> => {
            const usage = await fetchAgentUsage(deps, loc.agentId).catch(() => null);
            if (!usage) return null;
            return { ...usage, owner: loc.owner ?? null, workerId: loc.workerId ?? null };
          }),
        )).filter((r): r is OperatorUsageAgentRow => r !== null);

        const totals = {
          agentCount: rows.length,
          sessionCount: sum(rows, (r) => r.sessionCount),
          totalCost: sum(rows, (r) => r.totalCost),
          totalTokens: sum(rows, (r) => r.totalTokens),
        };

        // Per-product subtotals — pure upward aggregation over the agent rows.
        const byProductMap = new Map<string, { agentCount: number; sessionCount: number; totalCost: number; totalTokens: number }>();
        for (const r of rows) {
          const key = r.owner ?? '(unowned)';
          const acc = byProductMap.get(key) ?? { agentCount: 0, sessionCount: 0, totalCost: 0, totalTokens: 0 };
          acc.agentCount += 1;
          acc.sessionCount += r.sessionCount;
          acc.totalCost += r.totalCost;
          acc.totalTokens += r.totalTokens;
          byProductMap.set(key, acc);
        }
        const byProduct = [...byProductMap.entries()]
          .map(([product, v]) => ({ product, ...v }))
          .sort((a, b) => b.totalCost - a.totalCost);

        writeJson(res, 200, operatorUsageResponseSchema.parse({ totals, byProduct, agents: rows }));
      },
    },
  ];
}

/**
 * Proxy GET /agents/:id/usage to the agent's owning worker and parse the
 * reply. Returns the AgentUsage, or null when the worker has no record (a
 * brand-new or never-run agent). Throws an HttpError only when the agent
 * has no assigned worker — callers that aggregate swallow that.
 */
async function fetchAgentUsage<TEntry>(deps: ServerDeps<TEntry>, agentId: string): Promise<AgentUsage | null> {
  const entry = resolveAgentWorker(deps, agentId);
  const response = await fetch(`${entry.callbackUrl}${WORKER_PATHS.agentUsage(agentId)}`, {
    method: 'GET',
    headers: { [WORKER_AUTH_HEADER]: workerAuthHeader(entry.token) },
  });
  if (!response.ok) {
    throw httpError(response.status, 'worker_usage_failed', `worker returned ${response.status} for usage`);
  }
  const parsed = agentUsageResponseSchema.parse(await response.json());
  return parsed.usage;
}

function sum<T>(rows: T[], pick: (r: T) => number): number {
  return rows.reduce((acc, r) => acc + pick(r), 0);
}
