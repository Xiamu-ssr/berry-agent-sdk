// ============================================================
// @berry-agent/worker-daemon — Machine-mode resolveSpec helper
// ============================================================
//
// Parallel to withClusterAdminHostTools / withTeamModeHostTools: a
// resolveSpec wrapper that, when the wire spec carries
// `labels.machines = "id1,id2,..."`, injects each listed machine's exec
// tools as hostTools. The agent then sees `machine_<id>_exec` tools and
// can operate those hosts — "选 Hand = 选机器" made literal.
//
// The tools call a8s's exec broker (A8sOperatorClient.machineExec), which
// holds the machine token and forwards. The worker daemon already has the
// admin token (join handshake), so it can authenticate the broker call.
// No machine credential ever reaches the worker or the agent.

import {
  A8sOperatorClient,
  buildMachineTools,
} from '@berry-agent/a8s-admin';
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
 * Wrap a resolveSpec so any wire spec with `labels.machines` gets exec
 * tools for each listed machine injected as hostTools. Hosts that don't
 * use the machine layer leave this off; the berry-worker CLI applies it
 * by default whenever an admin token is configured.
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

  return (wire) => {
    const baseSpec = baseResolve(wire);
    const machineIds = parseMachineIds(wire.labels?.machines);
    if (machineIds.length === 0) return baseSpec;

    const machineTools: ToolRegistration[] = machineIds.flatMap((machineId) =>
      buildMachineTools({ client, machineId }),
    );
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
