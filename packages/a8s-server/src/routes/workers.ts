// ============================================================
// Routes: workers (register / heartbeat / withdraw + operator ops)
// ============================================================
//
// Worker lifecycle. Registration accepts the admin token as bootstrap
// secret; subsequent calls use the per-worker token issued in the
// register response. Operator ops (drain / undrain / evict / join-
// script) require admin token and are audited.

import { randomBytes } from 'node:crypto';
import { HttpWorkerNode } from '@berry-agent/a8s';
import {
  A8S_PATHS,
  ADMIN_AUTH_HEADER,
  WORKER_AUTH_HEADER,
  adminAuthHeader,
  operatorJoinScriptRequestSchema,
  operatorJoinScriptResponseSchema,
  operatorOkResponseSchema,
  operatorWorkerListResponseSchema,
  operatorWorkerSchema,
  parseAdminAuthHeader,
  workerHeartbeatRequestSchema,
  workerHeartbeatResponseSchema,
  workerRegistrationRequestSchema,
  workerRegistrationResponseSchema,
  workerWithdrawRequestSchema,
} from '@berry-agent/cluster-protocol';
import { readJsonBody, writeJson } from '../http-helpers.js';
import { httpError, type RouteDefinition } from '../router.js';
import type { ServerDeps } from '../deps.js';
import { requireAdminToken, requireWorkerToken } from '../auth.js';
import { withAudit } from '../middleware.js';

export function workerRoutes<TEntry>(deps: ServerDeps<TEntry>): RouteDefinition[] {
  return [
    // ---- Worker self-service ----
    {
      method: 'POST',
      pattern: A8S_PATHS.workersRegister,
      name: 'POST /v1/workers/register',
      middleware: [requireAdminTokenForRegister(deps)],
      handler: async (ctx) => handleRegister(deps, ctx),
    },
    {
      method: 'POST',
      pattern: '/v1/workers/:workerId/heartbeat',
      name: 'POST /v1/workers/:id/heartbeat',
      middleware: [requireWorkerToken(deps)],
      handler: async ({ params, req, res }) => {
        const body = await readJsonBody(req);
        const parsed = workerHeartbeatRequestSchema.parse(body);
        const entry = deps.tokens.get(params.workerId)!;
        const refreshed = await deps.plane.orchestrator.heartbeatWorker(params.workerId, entry.heartbeatTtlMs);
        if (!refreshed) {
          throw httpError(410, 'worker_evicted', `worker ${params.workerId} has been evicted; please re-register`);
        }
        // Converge the leases of agents this worker is actually running.
        // renew-if-held / acquire-if-absent (revives an expired lease, e.g. an
        // idle agent recovered from disk after a restart) / skip-if-conflict.
        // Same helper as registration → one source of truth.
        for (const agentId of parsed.mountedAgents ?? []) {
          const outcome = await convergeMountedAgent(deps, agentId, params.workerId, entry.heartbeatTtlMs);
          if (typeof outcome === 'object') {
            deps.logger.warn?.(
              `[a8s-server] worker ${params.workerId} heartbeats mount of ${agentId} but lease is held by ${outcome.conflict}; keeping holder`,
            );
          }
        }
        writeJson(res, 200, workerHeartbeatResponseSchema.parse({
          ok: true,
          heartbeatTtlMs: entry.heartbeatTtlMs,
        }));
      },
    },
    {
      method: 'POST',
      pattern: '/v1/workers/:workerId/withdraw',
      name: 'POST /v1/workers/:id/withdraw',
      middleware: [requireWorkerToken(deps)],
      handler: async ({ params, req, res }) => {
        const body = await readJsonBody(req);
        workerWithdrawRequestSchema.parse(body);
        await deps.plane.orchestrator.withdrawWorker(params.workerId);
        deps.plane.removeWorker(params.workerId);
        deps.tokens.delete(params.workerId);
        writeJson(res, 200, { ok: true });
      },
    },

    // ---- Operator: list / drain / undrain / evict ----
    {
      method: 'GET',
      pattern: A8S_PATHS.operatorWorkers,
      name: 'GET /v1/operator/workers',
      middleware: [requireAdminToken(deps)],
      handler: async ({ res }) => {
        const orchWorkers = await deps.plane.orchestrator.listWorkers();
        const agents = deps.plane.listAgents();
        const usedByWorker = new Map<string, number>();
        for (const a of agents) {
          if (!a.workerId) continue;
          usedByWorker.set(a.workerId, (usedByWorker.get(a.workerId) ?? 0) + 1);
        }
        const list = orchWorkers.map((w) => {
          const tok = deps.tokens.get(w.workerId);
          return operatorWorkerSchema.parse({
            workerId: w.workerId,
            state: w.state,
            capacity: w.capacity,
            used: usedByWorker.get(w.workerId) ?? 0,
            callbackUrl: tok?.callbackUrl ?? 'http://unknown',
            labels: w.labels,
            registeredAt: w.registeredAt,
            heartbeatAt: w.heartbeatAt,
            heartbeatExpiresAt: w.heartbeatExpiresAt,
            drainedAt: w.drainedAt,
            evictedAt: w.evictedAt,
            withdrawnAt: w.withdrawnAt,
          });
        });
        writeJson(res, 200, operatorWorkerListResponseSchema.parse({ workers: list }));
      },
    },
    {
      method: 'POST',
      pattern: '/v1/operator/workers/:workerId/drain',
      name: 'POST /v1/operator/workers/:id/drain',
      middleware: [
        requireAdminToken(deps),
        withAudit(deps.audit, {
          action: 'worker.drain',
          target: (ctx) => ctx.params.workerId,
        }),
      ],
      handler: async ({ params, res }) => {
        const result = await deps.plane.orchestrator.drainWorker(params.workerId);
        if (!result) {
          throw httpError(404, 'unknown_worker', `worker "${params.workerId}" not registered`);
        }
        writeJson(res, 200, operatorOkResponseSchema.parse({ ok: true }));
      },
    },
    {
      method: 'POST',
      pattern: '/v1/operator/workers/:workerId/undrain',
      name: 'POST /v1/operator/workers/:id/undrain',
      middleware: [
        requireAdminToken(deps),
        withAudit(deps.audit, {
          action: 'worker.undrain',
          target: (ctx) => ctx.params.workerId,
        }),
      ],
      handler: async ({ params, res }) => {
        const tok = deps.tokens.get(params.workerId);
        if (!tok) {
          throw httpError(404, 'unknown_worker',
            `worker "${params.workerId}" not registered with this control plane process`);
        }
        await deps.plane.orchestrator.registerWorker({
          workerId: params.workerId,
          holderId: params.workerId,
          capacity: tok.capacity,
          heartbeatTtlMs: tok.heartbeatTtlMs,
        });
        writeJson(res, 200, operatorOkResponseSchema.parse({ ok: true }));
      },
    },
    {
      method: 'POST',
      pattern: '/v1/operator/workers/:workerId/evict',
      name: 'POST /v1/operator/workers/:id/evict',
      middleware: [
        requireAdminToken(deps),
        withAudit(deps.audit, {
          action: 'worker.evict',
          target: (ctx) => ctx.params.workerId,
        }),
      ],
      handler: async ({ params, res }) => {
        const result = await deps.plane.orchestrator.withdrawWorker(params.workerId);
        if (!result) {
          throw httpError(404, 'unknown_worker', `worker "${params.workerId}" not registered`);
        }
        deps.plane.removeWorker(params.workerId);
        deps.tokens.delete(params.workerId);
        writeJson(res, 200, operatorOkResponseSchema.parse({ ok: true }));
      },
    },
    {
      method: 'POST',
      pattern: A8S_PATHS.operatorWorkerJoinScript,
      name: 'POST /v1/operator/workers/join-script',
      middleware: [
        requireAdminToken(deps),
        withAudit(deps.audit, {
          action: 'worker.join_script_issued',
        }),
      ],
      handler: async ({ req, res }) => handleJoinScript(deps, req, res),
    },
  ];
}

/** Register accepts the admin token as bootstrap, not the per-worker token. */
function requireAdminTokenForRegister(deps: ServerDeps) {
  return requireAdminToken(deps);
}

async function handleRegister<TEntry>(
  deps: ServerDeps<TEntry>,
  ctx: { req: import('node:http').IncomingMessage; res: import('node:http').ServerResponse },
): Promise<void> {
  const body = await readJsonBody(ctx.req);
  const parsed = workerRegistrationRequestSchema.parse(body);

  const token = randomBytes(32).toString('base64url');
  deps.tokens.set(parsed.workerId, {
    workerId: parsed.workerId,
    token,
    callbackUrl: parsed.callbackUrl,
    capacity: parsed.capacity,
    heartbeatTtlMs: parsed.heartbeatTtlMs,
  });

  await deps.plane.orchestrator.registerWorker({
    workerId: parsed.workerId,
    holderId: parsed.workerId,
    capacity: parsed.capacity,
    heartbeatTtlMs: parsed.heartbeatTtlMs,
    labels: parsed.labels,
  });
  deps.plane.addWorker(new HttpWorkerNode<TEntry>({
    workerId: parsed.workerId,
    callbackUrl: parsed.callbackUrl,
    workerToken: token,
    labels: parsed.labels,
  }));

  const hydrated = await deps.plane.hydrateAssignments();
  if (hydrated.restored.length > 0) {
    deps.logger.log?.(
      `[a8s-server] hydrated ${hydrated.restored.length} assignment(s) after ${parsed.workerId} registered`,
    );
  }

  // Reverse convergence — mounted agents the orch doesn't already credit to
  // this worker get their lease renewed or (re)acquired via the shared
  // converge helper. Same logic the heartbeat uses.
  const reconciled: string[] = [];
  const conflicts: Array<{ agentId: string; existingHolder: string }> = [];
  for (const agentId of parsed.mountedAgents) {
    if (hydrated.restored.some((r) => r.agentId === agentId && r.workerId === parsed.workerId)) continue;
    const outcome = await convergeMountedAgent(deps, agentId, parsed.workerId, 5 * 60_000);
    if (typeof outcome === 'object') {
      conflicts.push({ agentId, existingHolder: outcome.conflict });
    } else {
      reconciled.push(agentId);
    }
  }
  if (reconciled.length > 0) {
    deps.logger.log?.(
      `[a8s-server] reconciled ${reconciled.length} self-reported mount(s) from ${parsed.workerId}: ${reconciled.join(', ')}`,
    );
  }
  for (const c of conflicts) {
    deps.logger.warn?.(
      `[a8s-server] worker ${parsed.workerId} reports mount of ${c.agentId} but lease is held by ${c.existingHolder}; keeping existing holder`,
    );
  }

  const ownedAgents = [
    ...hydrated.restored.filter((e) => e.workerId === parsed.workerId).map((e) => e.agentId),
    ...reconciled,
  ];

  // Audit worker registration here (it's part of the same handler as
  // the admin-token check; the middleware doesn't see workerId until
  // after we parse the body).
  void deps.audit.log({
    ts: Date.now(),
    action: 'worker.register',
    actor: 'admin-token',
    target: parsed.workerId,
    outcome: 'ok',
    details: { capacity: parsed.capacity, mountedAgents: parsed.mountedAgents.length },
  });

  writeJson(ctx.res, 200, workerRegistrationResponseSchema.parse({
    workerId: parsed.workerId,
    heartbeatTtlMs: parsed.heartbeatTtlMs,
    workerToken: token,
    ownedAgents,
  }));
}

/**
 * Converge one agent the worker reports as mounted onto the durable lease
 * table. Single source of truth for both register and heartbeat:
 *   - lease held by this worker → renew its TTL (keeps it alive while running)
 *   - no active lease → acquire one (revives an expired/absent lease, e.g.
 *     an idle agent recovered from disk after a restart past the TTL)
 *   - lease held by someone else → conflict; leave the real holder alone
 * Returns the outcome so callers can log / build ownedAgents.
 */
async function convergeMountedAgent<TEntry>(
  deps: ServerDeps<TEntry>,
  agentId: string,
  workerId: string,
  ttlMs: number,
): Promise<'renewed' | 'acquired' | { conflict: string }> {
  const renewed = await deps.plane.orchestrator.renewAgentLease(agentId, workerId, ttlMs);
  if (renewed) {
    deps.plane.bindAssignment(agentId, workerId);
    return 'renewed';
  }
  const acquired = await deps.plane.orchestrator.acquireLease({ agentId, holderId: workerId, workerId, ttlMs });
  if (acquired.acquired) {
    deps.plane.bindAssignment(agentId, workerId);
    return 'acquired';
  }
  if (acquired.active.workerId === workerId) {
    deps.plane.bindAssignment(agentId, workerId);
    return 'renewed';
  }
  return { conflict: acquired.active.workerId ?? acquired.active.holderId };
}

async function handleJoinScript<TEntry>(
  deps: ServerDeps<TEntry>,
  req: import('node:http').IncomingMessage,
  res: import('node:http').ServerResponse,
): Promise<void> {
  if (!deps.adminToken) {
    throw httpError(409, 'no_admin_token',
      'cannot generate a join script in dev mode (no --admin-token set); set one and restart a8s');
  }
  const body = await readJsonBody(req);
  const parsed = operatorJoinScriptRequestSchema.parse(body);

  const workerId = parsed.workerId ?? '$(hostname)';
  const capacity = parsed.capacity ?? 4;
  const port = parsed.port ?? 7100;
  const a8sUrl = deps.advertiseUrl ?? `http://localhost:${deps.port}`;
  const dataRoot = parsed.dataRoot ?? '/var/berry/workers/$WORKER_ID';
  const labelsJson = parsed.labels ? JSON.stringify(parsed.labels) : '{}';

  const script = `#!/usr/bin/env bash
# berry-worker join script — paste into an SSH session on the new host.
# Generated by a8s on ${new Date().toISOString()}.
set -euo pipefail

WORKER_ID="${workerId === '$(hostname)' ? '$(hostname)' : escapeShell(workerId)}"
DATA_ROOT="${dataRoot}"
A8S_URL="${escapeShell(a8sUrl)}"
PORT="${port}"
CAPACITY="${capacity}"
ADMIN_TOKEN="${escapeShell(deps.adminToken)}"

echo "[berry-join] installing @berry-agent/worker-daemon globally..."
npm install -g @berry-agent/worker-daemon

echo "[berry-join] preparing data root at $DATA_ROOT..."
sudo mkdir -p "$DATA_ROOT/agents"
sudo chown -R "$(id -un):$(id -gn)" "$DATA_ROOT"

CONFIG_PATH="$DATA_ROOT/worker.json"
echo "[berry-join] writing config to $CONFIG_PATH..."
cat > "$CONFIG_PATH" <<JSON
{
  "workerId": "$WORKER_ID",
  "port": $PORT,
  "a8s": "$A8S_URL",
  "adminToken": "$ADMIN_TOKEN",
  "capacity": $CAPACITY,
  "heartbeatTtlMs": 30000,
  "dataRoot": "$DATA_ROOT",
  "labels": ${labelsJson},
  "registry": null
}
JSON

echo "[berry-join] worker config written. NOTE: \\"registry\\" is null; edit"
echo "  $CONFIG_PATH to add your provider/model registry before starting,"
echo "  or this worker will fail to mount agents that need an LLM."
echo
echo "Start the worker with:"
echo "  berry-worker start --config $CONFIG_PATH"
`;

  writeJson(res, 200, operatorJoinScriptResponseSchema.parse({
    script,
    resolved: {
      workerId: parsed.workerId ?? '(target hostname)',
      capacity,
      port,
      a8sUrl,
      dataRoot,
    },
  }));
}

/**
 * Escape a string for safe embedding inside a bash double-quoted
 * context. The script uses "..." for every interpolation site, so we
 * only escape characters that have meaning inside double quotes.
 */
function escapeShell(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\$/g, '\\$')
    .replace(/`/g, '\\`')
    .replace(/"/g, '\\"');
}

// Silence unused-import warning — these are exported so route declarations
// can reference them even when this file's main exports compile cleanly.
void ADMIN_AUTH_HEADER;
void WORKER_AUTH_HEADER;
void adminAuthHeader;
void parseAdminAuthHeader;
