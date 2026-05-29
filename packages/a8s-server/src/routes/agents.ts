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
import type { WorkerAgentSpec } from '@berry-agent/worker';
import { readJsonBody, writeJson } from '../http-helpers.js';
import { httpError, type RouteDefinition } from '../router.js';
import type { ServerDeps } from '../deps.js';
import { requireAdminToken } from '../auth.js';
import { withAudit } from '../middleware.js';

export function agentRoutes<TEntry>(deps: ServerDeps<TEntry>): RouteDefinition[] {
  return [
    {
      method: 'GET',
      pattern: A8S_PATHS.agents,
      name: 'GET /v1/agents',
      middleware: [requireAdminToken(deps)],
      handler: ({ res }) => {
        const agents = deps.plane.listAgents().map((entry) =>
          agentLocationSchema.parse({ agentId: entry.agentId, workerId: entry.workerId }),
        );
        writeJson(res, 200, listAgentsResponseSchema.parse({ agents }));
      },
    },
    {
      method: 'POST',
      pattern: A8S_PATHS.agents,
      name: 'POST /v1/agents',
      middleware: [
        requireAdminToken(deps),
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
      handler: async ({ req, res }) => handleCreateAgent(deps, req, res),
    },
    {
      method: 'GET',
      pattern: '/v1/agents/:agentId',
      name: 'GET /v1/agents/:id',
      middleware: [requireAdminToken(deps)],
      handler: ({ params, res }) => {
        const loc = deps.plane.getAgentLocation(params.agentId);
        writeJson(res, 200, agentLocationSchema.parse(loc));
      },
    },
    {
      method: 'DELETE',
      pattern: '/v1/agents/:agentId',
      name: 'DELETE /v1/agents/:id',
      middleware: [
        requireAdminToken(deps),
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
      middleware: [requireAdminToken(deps)],
      handler: async ({ params, req, res }) => {
        const body = await readJsonBody(req);
        const parsed = sendRequestSchema.parse(body);
        const entry = resolveAgentWorker(deps, params.agentId);
        const response = await fetch(`${entry.callbackUrl}${WORKER_PATHS.agentSend(params.agentId)}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            [WORKER_AUTH_HEADER]: workerAuthHeader(entry.token),
          },
          body: JSON.stringify(parsed),
        });
        const text = await response.text();
        res.statusCode = response.status;
        res.setHeader('content-type', 'application/json');
        res.end(text);
      },
    },
  ];
}

/**
 * Look up the worker that owns `agentId` and return its token entry.
 * Throws an HttpError when the agent isn't assigned or the worker has
 * no in-memory token (the second case indicates a8s lost state).
 */
export function resolveAgentWorker<TEntry>(deps: ServerDeps<TEntry>, agentId: string) {
  const loc = deps.plane.getAgentLocation(agentId);
  if (!loc.workerId) {
    throw httpError(404, 'agent_not_assigned', `agent "${agentId}" has no assigned worker`);
  }
  const entry = deps.tokens.get(loc.workerId);
  if (!entry) {
    throw httpError(500, 'worker_token_missing', `no token for worker ${loc.workerId}`);
  }
  return entry;
}

async function handleCreateAgent<TEntry>(
  deps: ServerDeps<TEntry>,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const body = await readJsonBody(req);
  const parsed = createAgentRequestSchema.parse(body);

  const wireSpec: WorkerAgentSpec = {
    agentId: parsed.spec.agentId,
    workspace: parsed.spec.workspace,
    projectRoot: parsed.spec.projectRoot,
    home: undefined as unknown as WorkerAgentSpec['home'],
    model: parsed.spec.model,
    ensureDefaultMcpConfig: parsed.spec.ensureDefaultMcpConfig,
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
