// ============================================================
// Routes: sessions (list + paginated events + SSE stream)
// ============================================================
//
// All three are proxies — a8s holds no session state, just looks up
// the owning worker and forwards. SSE needs a streaming proxy
// (fetch + body.getReader, not text()), the others use the simple
// GET proxy helper.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { SSE_LAST_EVENT_ID_HEADER } from '@berry-agent/cluster-protocol';
import { writeJson } from '../http-helpers.js';
import type { RouteDefinition } from '../router.js';
import type { ServerDeps } from '../deps.js';
import { requireAgentScope } from '../auth.js';
import { workerFetch, withQuery } from './worker-proxy.js';

export function sessionRoutes<TEntry>(deps: ServerDeps<TEntry>): RouteDefinition[] {
  const enc = encodeURIComponent;
  return [
    {
      method: 'GET',
      pattern: '/v1/agents/:agentId/sessions',
      name: 'GET /v1/agents/:id/sessions',
      middleware: [requireAgentScope(deps)],
      handler: async ({ params, req, res }) => {
        await proxyGetToWorker(deps, params.agentId, withQuery(`/v1/agents/${enc(params.agentId)}/sessions`, req.url), res);
      },
    },
    {
      method: 'GET',
      pattern: '/v1/agents/:agentId/sessions/:sessionId/events',
      name: 'GET /v1/agents/:id/sessions/:sid/events',
      middleware: [requireAgentScope(deps)],
      handler: async ({ params, req, res }) => {
        await proxyGetToWorker(
          deps,
          params.agentId,
          withQuery(`/v1/agents/${enc(params.agentId)}/sessions/${enc(params.sessionId)}/events`, req.url),
          res,
        );
      },
    },
    {
      method: 'GET',
      pattern: '/v1/agents/:agentId/events/stream',
      name: 'GET /v1/agents/:id/events/stream',
      middleware: [requireAgentScope(deps)],
      handler: async ({ params, req, res }) => {
        await proxyStreamToWorker(
          deps,
          params.agentId,
          withQuery(`/v1/agents/${enc(params.agentId)}/events/stream`, req.url),
          req,
          res,
        );
      },
    },
  ];
}

async function proxyGetToWorker<TEntry>(
  deps: ServerDeps<TEntry>,
  agentId: string,
  subpath: string,
  res: ServerResponse,
): Promise<void> {
  const response = await workerFetch(deps, agentId, subpath);
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
  const lastEventId = req.headers[SSE_LAST_EVENT_ID_HEADER.toLowerCase()] as string | undefined;
  const upstream = await workerFetch(deps, agentId, subpath, {
    headers: {
      accept: 'text/event-stream',
      ...(lastEventId ? { [SSE_LAST_EVENT_ID_HEADER]: lastEventId } : {}),
    },
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
    try { void reader.cancel(); } catch (err) {
      deps.logger.warn?.('[a8s-server] SSE reader cancel failed (already closed?):', err);
    }
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
