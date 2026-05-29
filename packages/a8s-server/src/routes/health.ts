// ============================================================
// Routes: health, /metrics, /ui
// ============================================================
//
// Unauthenticated endpoints. /ui serves the React app built in
// `ui/` (output dist/ui/). The page itself ships no secrets; the
// user pastes the admin token into an in-page modal which lives in
// localStorage. /metrics is also unauthenticated by convention
// (Prometheus scrape targets historically don't auth) — put it behind
// nginx for restricted deployments.

import { A8S_PATHS, healthResponseSchema } from '@berry-agent/cluster-protocol';
import { writeJson, writeText } from '../http-helpers.js';
import type { RouteContext, RouteDefinition } from '../router.js';
import type { ServerDeps } from '../deps.js';
import { fallbackHtml, loadUiAsset } from '../ui-assets.js';

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
        const agents = deps.plane.listAgents();
        deps.metrics.agentsTotal.set(agents.length);
        writeText(res, 200, deps.metrics.render(), 'text/plain; version=0.0.4');
      },
    },
  ];
}

export function uiRoutes(_deps: ServerDeps): RouteDefinition[] {
  return [
    // Root and bare /ui → index.html
    { method: 'GET', pattern: '/', name: 'GET /', handler: serveIndex },
    { method: 'GET', pattern: '/ui', name: 'GET /ui', handler: serveIndex },
    { method: 'GET', pattern: '/ui/', name: 'GET /ui/', handler: serveIndex },
    // SPA assets: /ui/assets/foo.js, /ui/index-XYZ.css, etc.
    {
      method: 'GET',
      pattern: '/ui/:asset',
      name: 'GET /ui/:asset',
      handler: ({ params, res }) => serveAsset(`/${params.asset}`, res),
    },
    {
      method: 'GET',
      pattern: '/ui/:dir/:asset',
      name: 'GET /ui/:dir/:asset',
      handler: ({ params, res }) => serveAsset(`/${params.dir}/${params.asset}`, res),
    },
  ];
}

async function serveIndex({ res }: RouteContext): Promise<void> {
  const asset = (await loadUiAsset('/index.html')) ?? fallbackHtml();
  res.statusCode = 200;
  res.setHeader('content-type', asset.contentType);
  res.setHeader('cache-control', asset.cacheControl);
  res.end(asset.body);
}

async function serveAsset(rel: string, res: import('node:http').ServerResponse): Promise<void> {
  const asset = await loadUiAsset(rel);
  if (!asset) {
    res.statusCode = 404;
    res.setHeader('content-type', 'text/plain');
    res.end(`not found: ${rel}`);
    return;
  }
  res.statusCode = 200;
  res.setHeader('content-type', asset.contentType);
  res.setHeader('cache-control', asset.cacheControl);
  res.end(asset.body);
}
