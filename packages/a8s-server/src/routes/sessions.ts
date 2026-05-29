// ============================================================
// Routes: sessions (list + paginated events + SSE stream)
// ============================================================
//
// All three are proxies — a8s holds no session state, just looks up
// the owning worker and forwards. SSE needs a streaming proxy
// (fetch + body.getReader, not text()), the others use the simple
// GET proxy helper.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { SSE_LAST_EVENT_ID_HEADER, WORKER_AUTH_HEADER, workerAuthHeader } from '@berry-agent/cluster-protocol';
import { writeJson } from '../http-helpers.js';
import type { RouteDefinition } from '../router.js';
import type { ServerDeps } from '../deps.js';
import { requireAdminToken } from '../auth.js';
import { resolveAgentWorker } from './agents.js';

export function sessionRoutes<TEntry>(deps: ServerDeps<TEntry>): RouteDefinition[] {
  return [
    {
      method: 'GET',
      pattern: '/v1/agents/:agentId/sessions',
      name: 'GET /v1/agents/:id/sessions',
      middleware: [requireAdminToken(deps)],
      handler: async ({ params, req, res }) => {
        await proxyGetToWorker(deps, params.agentId, sessionsSubpath(params.agentId, req.url), res);
      },
    },
    {
      method: 'GET',
      pattern: '/v1/agents/:agentId/sessions/:sessionId/events',
      name: 'GET /v1/agents/:id/sessions/:sid/events',
      middleware: [requireAdminToken(deps)],
      handler: async ({ params, req, res }) => {
        await proxyGetToWorker(
          deps,
          params.agentId,
          sessionEventsSubpath(params.agentId, params.sessionId, req.url),
          res,
        );
      },
    },
    {
      method: 'GET',
      pattern: '/v1/agents/:agentId/events/stream',
      name: 'GET /v1/agents/:id/events/stream',
      middleware: [requireAdminToken(deps)],
      handler: async ({ params, req, res }) => {
        await proxyStreamToWorker(
          deps,
          params.agentId,
          streamSubpath(params.agentId, req.url),
          req,
          res,
        );
      },
    },
  ];
}

function sessionsSubpath(agentId: string, url: string | undefined): string {
  const path = `/v1/agents/${encodeURIComponent(agentId)}/sessions`;
  const q = url ? extractQuery(url) : '';
  return `${path}${q}`;
}

function sessionEventsSubpath(agentId: string, sessionId: string, url: string | undefined): string {
  const path = `/v1/agents/${encodeURIComponent(agentId)}/sessions/${encodeURIComponent(sessionId)}/events`;
  const q = url ? extractQuery(url) : '';
  return `${path}${q}`;
}

function streamSubpath(agentId: string, url: string | undefined): string {
  const path = `/v1/agents/${encodeURIComponent(agentId)}/events/stream`;
  const q = url ? extractQuery(url) : '';
  return `${path}${q}`;
}

function extractQuery(url: string): string {
  const i = url.indexOf('?');
  return i >= 0 ? url.slice(i) : '';
}

async function proxyGetToWorker<TEntry>(
  deps: ServerDeps<TEntry>,
  agentId: string,
  subpath: string,
  res: ServerResponse,
): Promise<void> {
  const entry = resolveAgentWorker(deps, agentId);
  const response = await fetch(`${entry.callbackUrl}${subpath}`, {
    method: 'GET',
    headers: { [WORKER_AUTH_HEADER]: workerAuthHeader(entry.token) },
  });
  const text = await response.text();
  res.statusCode = response.status;
  res.setHeader('content-type', 'application/json');
  res.end(text);
}

async function proxyStreamToWorker<TEntry>(
  deps: ServerDeps<TEntry>,
  agentId: string,
  subpath: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const entry = resolveAgentWorker(deps, agentId);
  const lastEventId = req.headers[SSE_LAST_EVENT_ID_HEADER.toLowerCase()] as string | undefined;
  const upstreamHeaders: Record<string, string> = {
    [WORKER_AUTH_HEADER]: workerAuthHeader(entry.token),
    accept: 'text/event-stream',
  };
  if (lastEventId) upstreamHeaders[SSE_LAST_EVENT_ID_HEADER] = lastEventId;

  const upstream = await fetch(`${entry.callbackUrl}${subpath}`, {
    method: 'GET',
    headers: upstreamHeaders,
  });

  res.statusCode = upstream.status;
  if (upstream.status !== 200 || !upstream.body) {
    const text = await upstream.text();
    res.setHeader('content-type', upstream.headers.get('content-type') ?? 'application/json');
    res.end(text);
    return;
  }
  res.setHeader('content-type', 'text/event-stream');
  res.setHeader('cache-control', 'no-cache, no-transform');
  res.setHeader('connection', 'keep-alive');
  res.setHeader('x-accel-buffering', 'no');
  res.flushHeaders?.();

  const reader = upstream.body.getReader();
  const cancel = (): void => {
    try { void reader.cancel(); } catch { /* swallow */ }
  };
  req.on('close', cancel);
  req.on('aborted', cancel);

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value && !res.writableEnded) res.write(value);
      if (res.writableEnded) {
        cancel();
        break;
      }
    }
  } catch (error) {
    deps.logger.warn?.('[a8s-server] SSE upstream read failed:', error);
  } finally {
    if (!res.writableEnded) res.end();
  }

  // SSE never gets writeJson — the response is text/event-stream by
  // contract. Returning void here is intentional.
  void writeJson;
}
