// ============================================================
// Routes: machines (register / heartbeat / withdraw + exec proxy + operator list)
// ============================================================
//
// The a8s side of the machine layer. A connector registers (admin-token
// bootstrap → machine token), heartbeats, and serves /exec. a8s holds
// the machine token and brokers exec: an agent's machine Hand calls
// a8s (admin-scoped, which workers already hold), and a8s forwards to
// the machine's /exec with the machine token. Machine credentials never
// leave a8s.

import {
  A8S_PATHS,
  MACHINE_PATHS,
  WORKER_AUTH_HEADER,
  machineExecReplySchema,
  machineExecRequestSchema,
  machineHeartbeatResponseSchema,
  machineMcpInvokeReplySchema,
  machineMcpInvokeRequestSchema,
  machineMcpManifestSchema,
  machineRegistrationRequestSchema,
  machineRegistrationResponseSchema,
  machineWithdrawRequestSchema,
  operatorMachineJoinScriptRequestSchema,
  operatorMachineJoinScriptResponseSchema,
  operatorMachineListResponseSchema,
  operatorMachineSchema,
  workerAuthHeader,
} from '@berry-agent/cluster-protocol';
import { readJsonBody, writeJson } from '../http-helpers.js';
import { httpError, type RouteDefinition } from '../router.js';
import type { ServerDeps } from '../deps.js';
import { requireAdminToken, requireMachineToken } from '../auth.js';
import { withAudit } from '../middleware.js';

export function machineRoutes<TEntry>(deps: ServerDeps<TEntry>): RouteDefinition[] {
  return [
    // ---- Connector self-service ----
    {
      method: 'POST',
      pattern: A8S_PATHS.machinesRegister,
      name: 'POST /v1/machines/register',
      // Bootstrap with the admin token (proves "allowed to join"); the
      // response carries the machine token used thereafter.
      middleware: [requireAdminToken(deps)],
      handler: async ({ req, res }) => {
        const parsed = machineRegistrationRequestSchema.parse(await readJsonBody(req));
        const entry = deps.machines.register(parsed, Date.now());
        deps.logger.log?.(`[a8s-server] machine registered: ${entry.machineId} (${entry.platform ?? 'unknown'})`);
        writeJson(res, 200, machineRegistrationResponseSchema.parse({
          machineId: entry.machineId,
          heartbeatTtlMs: entry.heartbeatTtlMs,
          machineToken: entry.token,
        }));
      },
    },
    {
      method: 'POST',
      pattern: '/v1/machines/:machineId/heartbeat',
      name: 'POST /v1/machines/:id/heartbeat',
      middleware: [requireMachineToken(deps)],
      handler: async ({ params, res }) => {
        const ok = deps.machines.heartbeat(params.machineId, Date.now());
        if (!ok) {
          throw httpError(410, 'machine_gone', `machine ${params.machineId} is unknown; please re-register`);
        }
        const entry = deps.machines.get(params.machineId)!;
        writeJson(res, 200, machineHeartbeatResponseSchema.parse({
          ok: true,
          heartbeatTtlMs: entry.heartbeatTtlMs,
        }));
      },
    },
    {
      method: 'POST',
      pattern: '/v1/machines/:machineId/withdraw',
      name: 'POST /v1/machines/:id/withdraw',
      middleware: [requireMachineToken(deps)],
      handler: async ({ params, req, res }) => {
        machineWithdrawRequestSchema.parse(await readJsonBody(req));
        deps.machines.withdraw(params.machineId);
        writeJson(res, 200, { ok: true });
      },
    },

    // ---- exec proxy (agent/operator → a8s → machine) ----
    {
      method: 'POST',
      pattern: '/v1/machines/:machineId/exec',
      name: 'POST /v1/machines/:id/exec',
      // Admin-scoped: the caller is an agent's machine Hand (worker holds
      // the admin token) or an operator. a8s injects the machine token
      // when forwarding — the caller never sees it.
      middleware: [
        requireAdminToken(deps),
        withAudit(deps.audit, { action: 'machine.exec', target: (ctx) => ctx.params.machineId }),
      ],
      handler: async ({ params, req, res }) => {
        const entry = deps.machines.get(params.machineId);
        if (!entry) {
          throw httpError(404, 'unknown_machine', `machine "${params.machineId}" is not registered`);
        }
        if (deps.machines.stateOf(entry, Date.now()) !== 'active') {
          throw httpError(409, 'machine_unavailable', `machine "${params.machineId}" is not active (no recent heartbeat)`);
        }
        const execReq = machineExecRequestSchema.parse(await readJsonBody(req));
        const target = `${entry.callbackUrl.replace(/\/$/, '')}${MACHINE_PATHS.exec}`;
        let upstream: Response;
        try {
          upstream = await fetch(target, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              [WORKER_AUTH_HEADER]: workerAuthHeader(entry.token),
            },
            body: JSON.stringify(execReq),
          });
        } catch (err) {
          throw httpError(502, 'machine_unreachable', `machine "${params.machineId}" unreachable: ${err instanceof Error ? err.message : String(err)}`);
        }
        if (!upstream.ok) {
          const text = await upstream.text().catch(() => '');
          throw httpError(502, 'machine_exec_failed', `machine "${params.machineId}" exec HTTP ${upstream.status}: ${text.slice(0, 200)}`);
        }
        const reply = machineExecReplySchema.parse(await upstream.json());
        writeJson(res, 200, reply);
      },
    },

    // ---- MCP invoke proxy (agent → a8s → machine's local MCP) ----
    // a8s stays MCP-agnostic: it forwards {server, name, input} to the
    // connector, which holds the persistent stdio connection to the MCP
    // server. Same broker shape as exec — one-shot request/reply.
    {
      method: 'POST',
      pattern: '/v1/machines/:machineId/mcp/invoke',
      name: 'POST /v1/machines/:id/mcp/invoke',
      middleware: [
        requireAdminToken(deps),
        withAudit(deps.audit, { action: 'machine.mcp_invoke', target: (ctx) => ctx.params.machineId }),
      ],
      handler: async ({ params, req, res }) => {
        const entry = deps.machines.get(params.machineId);
        if (!entry) {
          throw httpError(404, 'unknown_machine', `machine "${params.machineId}" is not registered`);
        }
        if (deps.machines.stateOf(entry, Date.now()) !== 'active') {
          throw httpError(409, 'machine_unavailable', `machine "${params.machineId}" is not active (no recent heartbeat)`);
        }
        const invokeReq = machineMcpInvokeRequestSchema.parse(await readJsonBody(req));
        const target = `${entry.callbackUrl.replace(/\/$/, '')}${MACHINE_PATHS.mcpInvoke}`;
        let upstream: Response;
        try {
          upstream = await fetch(target, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              [WORKER_AUTH_HEADER]: workerAuthHeader(entry.token),
            },
            body: JSON.stringify(invokeReq),
          });
        } catch (err) {
          throw httpError(502, 'machine_unreachable', `machine "${params.machineId}" unreachable: ${err instanceof Error ? err.message : String(err)}`);
        }
        if (!upstream.ok) {
          const text = await upstream.text().catch(() => '');
          throw httpError(502, 'machine_mcp_failed', `machine "${params.machineId}" mcp invoke HTTP ${upstream.status}: ${text.slice(0, 200)}`);
        }
        const reply = machineMcpInvokeReplySchema.parse(await upstream.json());
        writeJson(res, 200, reply);
      },
    },

    // ---- MCP manifest discovery (brain → a8s) ----
    // The worker daemon fetches this to project each machine's MCP tools
    // into model-visible tools. Admin-scoped (workers hold the token).
    {
      method: 'GET',
      pattern: '/v1/machines/:machineId/mcp/manifest',
      name: 'GET /v1/machines/:id/mcp/manifest',
      middleware: [requireAdminToken(deps)],
      handler: ({ params, res }) => {
        const entry = deps.machines.get(params.machineId);
        if (!entry) {
          throw httpError(404, 'unknown_machine', `machine "${params.machineId}" is not registered`);
        }
        writeJson(res, 200, machineMcpManifestSchema.parse({ tools: entry.mcpTools }));
      },
    },

    // ---- Operator: list ----
    {
      method: 'GET',
      pattern: A8S_PATHS.operatorMachines,
      name: 'GET /v1/operator/machines',
      middleware: [requireAdminToken(deps)],
      handler: ({ res }) => {
        const now = Date.now();
        const machines = deps.machines.list().map((m) => operatorMachineSchema.parse({
          machineId: m.machineId,
          state: deps.machines.stateOf(m, now),
          callbackUrl: m.callbackUrl,
          platform: m.platform,
          labels: m.labels,
          mcpServers: m.mcpServers,
          mcpToolCount: m.mcpTools.length,
          registeredAt: m.registeredAt,
          heartbeatAt: m.heartbeatAt,
          heartbeatExpiresAt: m.heartbeatAt + m.heartbeatTtlMs,
        }));
        writeJson(res, 200, operatorMachineListResponseSchema.parse({ machines }));
      },
    },

    // ---- Operator: machine join-script ----
    {
      method: 'POST',
      pattern: A8S_PATHS.operatorMachineJoinScript,
      name: 'POST /v1/operator/machines/join-script',
      middleware: [requireAdminToken(deps)],
      handler: async ({ req, res }) => {
        if (!deps.adminToken) {
          throw httpError(409, 'no_admin_token',
            'cannot generate a join script in dev mode (no --admin-token set); set one and restart a8s');
        }
        const parsed = operatorMachineJoinScriptRequestSchema.parse(await readJsonBody(req));
        const machineId = parsed.machineId ?? '$(hostname)';
        const port = parsed.port ?? 7200;
        const a8sUrl = deps.advertiseUrl ?? `http://localhost:${deps.port}`;
        const script = `#!/usr/bin/env bash
# berry-machine connector join script — paste into an SSH session on the
# host you want to add. Generated by a8s on ${new Date().toISOString()}.
# It embeds the cluster admin token — treat as a secret, never log.
set -euo pipefail

MACHINE_ID="${machineId === '$(hostname)' ? '$(hostname)' : escapeShell(machineId)}"
A8S_URL="${escapeShell(a8sUrl)}"
PORT="${port}"
ADMIN_TOKEN="${escapeShell(deps.adminToken)}"

echo "[berry-join] installing @berry-agent/machine-connector globally..."
npm install -g @berry-agent/machine-connector

echo "[berry-join] starting connector (machine '$MACHINE_ID' on port $PORT)..."
echo "This machine will register with a8s and accept commands the cluster"
echo "sends — install it only on hosts you intend an agent to operate."
berry-machine start \\
  --a8s "$A8S_URL" \\
  --admin-token "$ADMIN_TOKEN" \\
  --machine-id "$MACHINE_ID" \\
  --port "$PORT"
`;
        writeJson(res, 200, operatorMachineJoinScriptResponseSchema.parse({
          script,
          resolved: {
            machineId: parsed.machineId ?? '(target hostname)',
            port,
            a8sUrl,
          },
        }));
      },
    },
  ];
}

/** Minimal single-quote shell escaping for embedding values in the script. */
function escapeShell(value: string): string {
  return value.replace(/'/g, `'\\''`);
}

