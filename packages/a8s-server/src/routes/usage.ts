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
  usageSessionListResponseSchema,
  usageTurnListResponseSchema,
  usageInferenceListResponseSchema,
  usageInferenceDetailResponseSchema,
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
    // ----- Drill-down: session → turn → inference → detail. All agent-scoped
    // so a8s resolves the owning worker via resolveAgentWorker and proxies the
    // GET verbatim (same pattern as sessions.ts). The worker reads its
    // observe.db; a8s holds no state. -----
    {
      method: 'GET',
      pattern: '/v1/agents/:agentId/usage/sessions',
      name: 'GET /v1/agents/:id/usage/sessions',
      middleware: [requireAgentScope(deps)],
      handler: async ({ params, res }) => {
        const body = await proxyUsageGet(deps, params.agentId, WORKER_PATHS.agentUsageSessions(params.agentId));
        writeJson(res, 200, usageSessionListResponseSchema.parse(body));
      },
    },
    {
      method: 'GET',
      pattern: '/v1/agents/:agentId/usage/sessions/:sessionId/turns',
      name: 'GET /v1/agents/:id/usage/sessions/:sid/turns',
      middleware: [requireAgentScope(deps)],
      handler: async ({ params, res }) => {
        const body = await proxyUsageGet(deps, params.agentId, WORKER_PATHS.agentUsageTurns(params.agentId, params.sessionId));
        writeJson(res, 200, usageTurnListResponseSchema.parse(body));
      },
    },
    {
      method: 'GET',
      pattern: '/v1/agents/:agentId/usage/turns/:turnId/inferences',
      name: 'GET /v1/agents/:id/usage/turns/:tid/inferences',
      middleware: [requireAgentScope(deps)],
      handler: async ({ params, res }) => {
        const body = await proxyUsageGet(deps, params.agentId, WORKER_PATHS.agentUsageInferences(params.agentId, params.turnId));
        writeJson(res, 200, usageInferenceListResponseSchema.parse(body));
      },
    },
    {
      method: 'GET',
      pattern: '/v1/agents/:agentId/usage/inferences/:inferenceId',
      name: 'GET /v1/agents/:id/usage/inferences/:iid',
      middleware: [requireAgentScope(deps)],
      handler: async ({ params, res }) => {
        const body = await proxyUsageGet(deps, params.agentId, WORKER_PATHS.agentUsageInferenceDetail(params.agentId, params.inferenceId));
        writeJson(res, 200, usageInferenceDetailResponseSchema.parse(body));
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

        // Per-model cluster rollup — fan-in over every agent's modelBreakdown.
        // Same "aggregate upward, never re-record" rule: each agent already
        // owns the per-model split; a8s only sums it across the cluster so an
        // operator can read which models the spend actually went to.
        const byModelMap = new Map<string, { agents: Set<string>; calls: number; totalCost: number; totalTokens: number }>();
        for (const r of rows) {
          for (const m of r.modelBreakdown ?? []) {
            const acc = byModelMap.get(m.model) ?? { agents: new Set<string>(), calls: 0, totalCost: 0, totalTokens: 0 };
            acc.agents.add(r.agentId);
            acc.calls += m.calls;
            acc.totalCost += m.totalCost;
            acc.totalTokens += m.totalTokens;
            byModelMap.set(m.model, acc);
          }
        }
        const byModel = [...byModelMap.entries()]
          .map(([model, v]) => ({ model, agentCount: v.agents.size, calls: v.calls, totalCost: v.totalCost, totalTokens: v.totalTokens }))
          .sort((a, b) => b.totalCost - a.totalCost);

        // Cluster cost trend by day — the time rung. Fan-in over every agent's
        // dailyTrend, keyed by UTC date so two agents that both spent on the
        // same day land in one bucket. Same "aggregate upward, never re-record"
        // rule as byModel/byProduct; sorted ascending so the consumer reads
        // left-to-right in time.
        const trendMap = new Map<string, { calls: number; totalCost: number }>();
        for (const r of rows) {
          for (const d of r.dailyTrend ?? []) {
            const acc = trendMap.get(d.date) ?? { calls: 0, totalCost: 0 };
            acc.calls += d.calls;
            acc.totalCost += d.totalCost;
            trendMap.set(d.date, acc);
          }
        }
        const trend = [...trendMap.entries()]
          .map(([date, v]) => ({ date, calls: v.calls, totalCost: v.totalCost }))
          .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

        writeJson(res, 200, operatorUsageResponseSchema.parse({ totals, byProduct, byModel, trend, agents: rows }));
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

/**
 * Proxy a GET to the agent's owning worker at the given subpath and return the
 * parsed JSON body. Used by the drill-down routes — a8s resolves the worker,
 * forwards with the worker token, and lets the route's own zod schema validate
 * the shape. Throws an HttpError on a non-2xx worker reply.
 */
async function proxyUsageGet<TEntry>(deps: ServerDeps<TEntry>, agentId: string, subpath: string): Promise<unknown> {
  const entry = resolveAgentWorker(deps, agentId);
  const response = await fetch(`${entry.callbackUrl}${subpath}`, {
    method: 'GET',
    headers: { [WORKER_AUTH_HEADER]: workerAuthHeader(entry.token) },
  });
  if (!response.ok) {
    throw httpError(response.status, 'worker_usage_failed', `worker returned ${response.status}`);
  }
  return response.json();
}
