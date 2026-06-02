// ============================================================
// @berry-agent/worker-daemon — Machine-mode resolveSpec helper
// ============================================================
//
// Parallel to withAdminOpsEnv / withTeamModeHostTools: a
// resolveSpec wrapper that, when the wire spec carries
// `labels.machines = "id1,id2,..."`, injects each listed machine's tools
// as hostTools. The agent then sees `machine_<id>_exec` plus one tool per
// MCP tool the machine proxies (`machine_<id>__<server>_<tool>`) and
// can operate those hosts — "选 Hand = 选机器" made literal.
//
// The tools call a8s's brokers (machineExec / machineMcpInvoke), which
// hold the machine token and forward. The worker daemon already has the
// admin token (join handshake), so it can authenticate the broker call.
// No machine credential ever reaches the worker or the agent.
//
// MCP manifest + resolveSpec's sync constraint: resolveSpec must return
// synchronously, but a machine's MCP manifest lives in a8s (async fetch).
// We bridge that with a manifest cache: the first resolve for a machine
// kicks off a background fetch and injects exec-only for now; once the
// manifest arrives it's cached, and the next agent mount (or re-mount)
// for that machine gets the full MCP tool set. Manifests are small and
// change rarely (only when the machine's .mcp.json changes + reconnects),
// so a lazily-warmed cache is the right trade — no blocking, eventual
// completeness.

import {
  A8sOperatorClient,
  buildMachineTools,
} from '@berry-agent/a8s-admin';
import type { MachineMcpTool } from '@berry-agent/cluster-protocol';
import type { ToolRegistration } from '@berry-agent/core';
import type { WorkerAgentSpec } from '@berry-agent/worker';
import type { WireResolveInput } from './team-mode.js';

export interface MachineModeResolverOptions {
  /** Base URL of the a8s control plane. */
  a8sUrl: string;
  /** Admin token — same one used for register handshake. */
  adminToken: string;
  /** Test injection. */
  fetch?: typeof fetch;
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
}

/** Parse the comma-separated `labels.machines` value into ids. */
function parseMachineIds(value: string | undefined): string[] {
  if (!value) return [];
  return value.split(',').map((s) => s.trim()).filter(Boolean);
}

/**
 * Wrap a resolveSpec so any wire spec with `labels.machines` gets tools
 * for each listed machine injected as hostTools. Hosts that don't use the
 * machine layer leave this off; the berry-worker CLI applies it by
 * default whenever an admin token is configured.
 *
 * Host-provided hostTools on the same name win; machine tools without
 * conflicts are appended.
 */
export function withMachineHostTools(
  baseResolve: (wire: WireResolveInput) => WorkerAgentSpec,
  options: MachineModeResolverOptions,
): (wire: WireResolveInput) => WorkerAgentSpec {
  // One shared client; tools close over it + a machineId.
  const client = new A8sOperatorClient({
    a8sUrl: options.a8sUrl,
    adminToken: options.adminToken,
    fetch: options.fetch,
  });
  const logger = options.logger ?? console;

  // machineId → its MCP manifest. Undefined = not yet fetched.
  const manifestCache = new Map<string, MachineMcpTool[]>();
  const inFlight = new Set<string>();

  const warm = (machineId: string): void => {
    if (manifestCache.has(machineId) || inFlight.has(machineId)) return;
    inFlight.add(machineId);
    void client.machineMcpManifest(machineId)
      .then((manifest) => { manifestCache.set(machineId, manifest.tools); })
      .catch((err) => {
        logger.warn?.(`[machine-mode] manifest fetch for "${machineId}" failed: ${err instanceof Error ? err.message : String(err)}`);
      })
      .finally(() => { inFlight.delete(machineId); });
  };

  return (wire) => {
    const baseSpec = baseResolve(wire);
    const machineIds = parseMachineIds(wire.labels?.machines);
    if (machineIds.length === 0) return baseSpec;

    const machineTools: ToolRegistration[] = machineIds.flatMap((machineId) => {
      const mcpTools = manifestCache.get(machineId);
      // Warm the cache for next time when we don't have it yet. The exec
      // tool is always available immediately; MCP tools appear once warm.
      if (mcpTools === undefined) warm(machineId);
      return buildMachineTools({ client, machineId, mcpTools });
    });
    const existing: ToolRegistration[] = Array.from(baseSpec.hostTools ?? []);
    const existingNames = new Set(existing.map((t) => t.definition.name));
    const additions = machineTools.filter((t) => !existingNames.has(t.definition.name));
    return {
      ...baseSpec,
      hostTools: [...existing, ...additions],
      hostHandDisplayName: baseSpec.hostHandDisplayName ?? 'Machine access',
    };
  };
}
