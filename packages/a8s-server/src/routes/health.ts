// ============================================================
// Routes: health, /metrics, /ui
// ============================================================
//
// Unauthenticated endpoints. /ui is the operator-facing single-page
// app; the page itself ships no secrets, the user pastes the admin
// token into an in-page modal. /metrics is also unauthenticated by
// convention (Prometheus scrape targets historically don't auth) — put
// it behind nginx for restricted deployments.

import { A8S_PATHS, healthResponseSchema } from '@berry-agent/cluster-protocol';
import { writeJson, writeText } from '../http-helpers.js';
import type { RouteDefinition } from '../router.js';
import type { ServerDeps } from '../deps.js';
import { A8S_UI_HTML } from '../ui-html.js';

export function healthRoutes(deps: ServerDeps): RouteDefinition[] {
  return [
    {
      method: 'GET',
      pattern: A8S_PATHS.health,
      name: 'GET /v1/health',
      handler: ({ res }) => {
        writeJson(res, 200, healthResponseSchema.parse({
          ok: true,
          version: deps.version,
          uptime: Math.floor((Date.now() - deps.startedAt) / 1000),
        }));
      },
    },
    {
      method: 'GET',
      pattern: '/metrics',
      name: 'GET /metrics',
      handler: ({ res }) => {
        // Refresh the cluster-cardinality gauges so /metrics is a
        // self-contained snapshot. Counters/histograms are accumulated
        // by the per-request metrics middleware.
        const agents = deps.plane.listAgents();
        deps.metrics.agentsTotal.set(agents.length);
        writeText(res, 200, deps.metrics.render(), 'text/plain; version=0.0.4');
      },
    },
  ];
}

export function uiRoutes(_deps: ServerDeps): RouteDefinition[] {
  const handler = (path: string) => ({
    method: 'GET' as const,
    pattern: path,
    name: `GET ${path}`,
    handler: ({ res }: { res: import('node:http').ServerResponse }) => {
      res.statusCode = 200;
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.setHeader('cache-control', 'no-store');
      res.end(A8S_UI_HTML);
    },
  });
  return [handler('/'), handler('/ui'), handler('/ui/')];
}
