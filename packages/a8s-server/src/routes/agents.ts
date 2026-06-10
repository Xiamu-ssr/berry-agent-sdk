// ============================================================
// Routes: agents (lifecycle + data-plane proxy)
// ============================================================
//
// Cluster-level agent operations + transparent proxies for per-agent
// data-plane reads/writes (send, session list, paginated events, SSE
// stream). Proxy targets are resolved via plane.getAgentLocation()
// → tokens[workerId].callbackUrl.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  A8S_PATHS,
  SSE_LAST_EVENT_ID_HEADER,
  WORKER_AUTH_HEADER,
  WORKER_PATHS,
  agentLocationSchema,
  createAgentRequestSchema,
  createAgentResponseSchema,
  listAgentsResponseSchema,
  sendRequestSchema,
  workerAuthHeader,
} from '@berry-agent/cluster-protocol';
import type { WireWorkerAgentSpec } from '@berry-agent/a8s';
import { readJsonBody, writeJson } from '../http-helpers.js';
import { httpError, type RouteDefinition, type RouteContext } from '../router.js';
import type { ServerDeps } from '../deps.js';
import { requireAdminToken, requireProductScope, requireAgentScope, scopeCanAccess } from '../auth.js';
import { withAudit } from '../middleware.js';
import { resolveAgentWorker } from './worker-proxy.js';

export function agentRoutes<TEntry>(deps: ServerDeps<TEntry>): RouteDefinition[] {
  return [
    {
      method: 'GET',
      pattern: A8S_PATHS.agents,
      name: 'GET /v1/agents',
      middleware: [requireProductScope(deps)],
      handler: ({ res, scope }) => {
        const agents = deps.plane.listAgents()
          .filter((loc) => scopeCanAccess(scope, loc.owner ?? undefined))
          .map((loc) => agentLocationSchema.parse({ agentId: loc.agentId, workerId: loc.workerId, owner: loc.owner ?? null, labels: loc.labels }));
        writeJson(res, 200, listAgentsResponseSchema.parse({ agents }));
      },
    },
    {
      method: 'POST',
      pattern: A8S_PATHS.agents,
      name: 'POST /v1/agents',
      middleware: [
        requireProductScope(deps),
        withAudit(deps.audit, {
          action: 'agent.create',
          target: (ctx) => {
            // Best-effort: target id lives in body; without buffering we
            // log it from the response by attaching `details` after the
            // handler ran. For now leave target undefined.
            void ctx;
            return undefined;
          },
        }),
      ],
      handler: async ({ req, res, scope }) => handleCreateAgent(deps, req, res, scope),
    },
    {
      method: 'GET',
      pattern: '/v1/agents/:agentId',
      name: 'GET /v1/agents/:id',
      middleware: [requireProductScope(deps)],
      handler: ({ params, res, scope }) => {
        const loc = deps.plane.getAgentLocation(params.agentId);
        if (!scopeCanAccess(scope, loc.owner ?? undefined)) {
          throw httpError(404, 'agent_not_found', `agent "${params.agentId}" not found`);
        }
        writeJson(res, 200, agentLocationSchema.parse(loc));
      },
    },
    {
      method: 'DELETE',
      pattern: '/v1/agents/:agentId',
      name: 'DELETE /v1/agents/:id',
      middleware: [
        requireAgentScope(deps),
        withAudit(deps.audit, { action: 'agent.delete', target: (ctx) => ctx.params.agentId }),
      ],
      handler: async ({ params, res }) => {
        await deps.plane.deleteAgent(params.agentId);
        writeJson(res, 200, { ok: true });
      },
    },
    {
      method: 'POST',
      pattern: '/v1/agents/:agentId/send',
      name: 'POST /v1/agents/:id/send',
      middleware: [requireAgentScope(deps)],
      handler: async ({ params, req, res }) => {
        // /send streams the turn back (SSE): validate the body, then pipe
        // the worker's event-stream response straight through. a8s holds no
        // turn state — it's a transparent streaming forward.
        const body = await readJsonBody(req);
        const parsed = sendRequestSchema.parse(body);
        const entry = resolveAgentWorker(deps, params.agentId);
        const upstream = await fetch(`${entry.callbackUrl}${WORKER_PATHS.agentSend(params.agentId)}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            [WORKER_AUTH_HEADER]: workerAuthHeader(entry.token),
          },
          body: JSON.stringify(parsed),
        });
        await pipeStreamingResponse(upstream, req, res, deps);
      },
    },

    // ---- Agent config & introspection (D1): transparent proxies ----
    // a8s and the worker share the exact agent sub-path, so each of these
    // just forwards the request (method + body) to the owning worker and
    // pipes the reply back. One helper, registered for each verb/path.
    proxyRoute(deps, 'GET', '/v1/agents/:agentId/home/:doc'),
    proxyRoute(deps, 'PUT', '/v1/agents/:agentId/home/:doc'),
    proxyRoute(deps, 'PATCH', '/v1/agents/:agentId/spec'),
    proxyRoute(deps, 'GET', '/v1/agents/:agentId/status'),
    proxyRoute(deps, 'GET', '/v1/agents/:agentId/snapshot'),
    proxyRoute(deps, 'GET', '/v1/agents/:agentId/skills'),
    proxyRoute(deps, 'POST', '/v1/agents/:agentId/skills'),
    proxyRoute(deps, 'DELETE', '/v1/agents/:agentId/skills/:name'),
    proxyRoute(deps, 'GET', '/v1/agents/:agentId/context-size'),
    proxyRoute(deps, 'POST', '/v1/agents/:agentId/pause'),
    proxyRoute(deps, 'POST', '/v1/agents/:agentId/interject'),

    // ---- Session write ops (D-sessions): same transparent proxy ----
    // Read side (list, events, stream) lives in sessions.ts; these mutate.
    proxyRoute(deps, 'POST', '/v1/agents/:agentId/sessions'),
    proxyRoute(deps, 'POST', '/v1/agents/:agentId/sessions/:sessionId/events'),
    proxyRoute(deps, 'GET', '/v1/agents/:agentId/sessions/:sessionId'),
    proxyRoute(deps, 'DELETE', '/v1/agents/:agentId/sessions/:sessionId'),
    proxyRoute(deps, 'POST', '/v1/agents/:agentId/sessions/:sessionId/clear'),
    proxyRoute(deps, 'GET', '/v1/agents/:agentId/sessions/:sessionId/todos'),
  ];
}

/**
 * Build a RouteDefinition that transparently forwards a per-agent request
 * to the worker that owns the agent. Because a8s and the worker daemon
 * expose the identical agent sub-path, we forward `req.url` verbatim
 * (preserving query string) with the method + body, and pipe the reply.
 */
function proxyRoute<TEntry>(
  deps: ServerDeps<TEntry>,
  method: 'GET' | 'PUT' | 'PATCH' | 'POST' | 'DELETE',
  pattern: string,
): RouteDefinition {
  return {
    method,
    pattern,
    name: `${method} ${pattern}`,
    middleware: [requireAgentScope(deps)],
    handler: async ({ params, req, res }) => {
      const entry = resolveAgentWorker(deps, params.agentId);
      const hasBody = method === 'PUT' || method === 'PATCH' || method === 'POST';
      const body = hasBody ? await readRawBody(req) : undefined;
      const response = await fetch(`${entry.callbackUrl}${req.url}`, {
        method,
        headers: {
          ...(hasBody ? { 'content-type': 'application/json' } : {}),
          [WORKER_AUTH_HEADER]: workerAuthHeader(entry.token),
        },
        body,
      });
      const text = await response.text();
      res.statusCode = response.status;
      res.setHeader('content-type', response.headers.get('content-type') ?? 'application/json');
      res.end(text);
    },
  };
}

/** Read the raw request body as a string (proxies forward bytes verbatim). */
async function readRawBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', (c) => { buf += c; });
    req.on('end', () => resolve(buf));
    req.on('error', reject);
  });
}

/**
 * Pipe a streaming upstream response (e.g. the worker's SSE turn stream)
 * straight through to the client, cancelling the upstream read if the
 * client disconnects. Non-200 / bodyless responses fall back to buffering
 * the text so error payloads still reach the client. a8s holds no state —
 * this is a transparent streaming forward.
 */
async function pipeStreamingResponse<TEntry>(
  upstream: Response,
  req: IncomingMessage,
  res: ServerResponse,
  deps: ServerDeps<TEntry>,
): Promise<void> {
  res.statusCode = upstream.status;
  if (upstream.status !== 200 || !upstream.body) {
    const text = await upstream.text();
    res.setHeader('content-type', upstream.headers.get('content-type') ?? 'application/json');
    res.end(text);
    return;
  }
  res.setHeader('content-type', upstream.headers.get('content-type') ?? 'text/event-stream');
  res.setHeader('cache-control', 'no-cache, no-transform');
  res.setHeader('connection', 'keep-alive');
  res.setHeader('x-accel-buffering', 'no');
  res.flushHeaders?.();

  const reader = upstream.body.getReader();
  const cancel = (): void => { try { void reader.cancel(); } catch { /* swallow */ } };
  req.on('close', cancel);
  req.on('aborted', cancel);

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value && !res.writableEnded) res.write(value);
      if (res.writableEnded) { cancel(); break; }
    }
  } catch (error) {
    deps.logger.warn?.('[a8s-server] streaming upstream read failed:', error);
  } finally {
    if (!res.writableEnded) res.end();
  }
}

async function handleCreateAgent<TEntry>(
  deps: ServerDeps<TEntry>,
  req: IncomingMessage,
  res: ServerResponse,
  scope: RouteContext['scope'],
): Promise<void> {
  const body = await readJsonBody(req);
  const parsed = createAgentRequestSchema.parse(body);

  // Stamp the owning product (or product:subject) onto the agent's labels so
  // the cluster can scope-filter it. A subject-scoped caller owns
  // `product:subject`; a product root token owns the bare `product`; the
  // operator ('*') may pass an explicit labels.owner or leave it unowned.
  const owner = scope && scope !== '*'
    ? (scope.subject !== undefined ? `${scope.product}:${scope.subject}` : scope.product)
    : parsed.spec.labels?.owner;
  const labels = owner ? { ...parsed.spec.labels, owner } : parsed.spec.labels;

  // Forward the wire spec straight to the plane — no fake AgentHome
  // construction here. Each WorkerNode (InProcess or Http) rehydrates
  // runtime-only fields locally.
  const wireSpec: WireWorkerAgentSpec = {
    agentId: parsed.spec.agentId,
    workspace: parsed.spec.workspace,
    projectRoot: parsed.spec.projectRoot,
    model: parsed.spec.model,
    classifierModel: parsed.spec.classifierModel,
    reasoningEffort: parsed.spec.reasoningEffort,
    toolDenylist: parsed.spec.toolDenylist,
    ensureDefaultMcpConfig: parsed.spec.ensureDefaultMcpConfig,
    labels,
  };

  const result = await deps.plane.createAgent(
    wireSpec,
    (parsed.entry ?? {}) as TEntry,
    { preferredMachine: parsed.preferredMachine },
  );

  const acquired = await deps.plane.orchestrator.acquireLease({
    agentId: result.agentId,
    holderId: result.workerId,
    workerId: result.workerId,
    ttlMs: 5 * 60_000,
    // Persist owner + full labels in the lease so team membership
    // (labels.project / team / role / leader) survives an a8s restart and is
    // restored by hydrateAssignments().
    ...((owner || labels) ? { metadata: { ...(owner ? { owner } : {}), ...(labels ? { labels } : {}) } } : {}),
  });
  if (!acquired.acquired) {
    deps.logger.warn?.(
      `[a8s-server] lease for ${result.agentId} already held by ${acquired.active.holderId}`,
    );
  }
  const leaseId = acquired.acquired ? acquired.lease.leaseId : acquired.active.leaseId;

  writeJson(res, 200, createAgentResponseSchema.parse({
    agentId: result.agentId,
    workerId: result.workerId,
    leaseId,
  }));
}

// Re-export for the SSE proxy in sessions.ts
export { SSE_LAST_EVENT_ID_HEADER };
