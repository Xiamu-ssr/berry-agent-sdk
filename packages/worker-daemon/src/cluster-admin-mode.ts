// ============================================================
// @berry-agent/worker-daemon — Cluster-admin-mode resolveSpec helper
// ============================================================
//
// Parallel to `withTeamModeHostTools`: a resolveSpec wrapper that,
// when the wire spec carries `labels.role === 'a8s-admin'`, injects
// the cluster-admin Hand tools (cluster_report / list_workers /
// drain_worker / ... — 8 tools) as hostTools so the agent can drive
// the cluster from natural-language chat.
//
// Why this lives in the worker daemon rather than in a8s-server:
//   - "Berry-admin" is a *product* running on a8s, not a8s itself.
//     a8s-server should not import a8s-admin or know what cluster-admin
//     tools exist; the worker that mounts the agent is the right place
//     to do per-agent tool injection (same pattern as team-mode).
//   - Worker daemon already has the admin token (needs it for join
//     handshake), so it can authenticate the agent's tool calls
//     against a8s without operator intervention.

import {
  A8sOperatorClient,
  buildClusterAdminTools,
  seedAdminAgentHome,
} from '@berry-agent/a8s-admin';
import type { ToolRegistration } from '@berry-agent/core';
import type { WorkerAgentSpec } from '@berry-agent/worker';
import type { WireResolveInput } from './team-mode.js';

export interface ClusterAdminModeResolverOptions {
  /** Base URL of the a8s control plane. */
  a8sUrl: string;
  /** Admin token — same one used for register handshake. */
  adminToken: string;
  /** Test injection. */
  fetch?: typeof fetch;
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
}

/**
 * Wrap a resolveSpec so any wire spec with `labels.role === 'a8s-admin'`
 * gets the cluster-admin Hand's 8 tools auto-injected. Hosts that don't
 * want admin agents leave this off; the berry-worker CLI applies it by
 * default whenever an admin token is configured.
 *
 * Host-provided hostTools on the same name win (the host had a reason
 * to override); cluster-admin tools without conflicts are appended.
 */
export function withClusterAdminHostTools(
  baseResolve: (wire: WireResolveInput) => WorkerAgentSpec,
  options: ClusterAdminModeResolverOptions,
): (wire: WireResolveInput) => WorkerAgentSpec {
  // Build the client + tools once per resolver; reused for every spec.
  // The tools close over the client, so a token rotation would require
  // a new resolver — acceptable for alpha (token rotation is restart).
  const client = new A8sOperatorClient({
    a8sUrl: options.a8sUrl,
    adminToken: options.adminToken,
    fetch: options.fetch,
  });
  const adminTools = buildClusterAdminTools(client);

  return (wire) => {
    const baseSpec = baseResolve(wire);
    if (wire.labels?.role !== 'a8s-admin') return baseSpec;
    // First-boot: seed default AGENTS.md if absent. Idempotent.
    // Runs at the physical host so the data lives where the agent does.
    seedAdminAgentHome(baseSpec.workspace);
    const existing: ToolRegistration[] = Array.from(baseSpec.hostTools ?? []);
    const existingNames = new Set(existing.map((t) => t.definition.name));
    const additions = adminTools.filter((t) => !existingNames.has(t.definition.name));
    return {
      ...baseSpec,
      hostTools: [...existing, ...additions],
      hostHandDisplayName: baseSpec.hostHandDisplayName ?? 'a8s cluster administration',
    };
  };
}
