// ============================================================
// @berry-agent/worker-daemon — Admin-ops-mode resolveSpec helper
// ============================================================
//
// Parallel to withTeamModeHostTools / withMachineHostTools: a resolveSpec
// wrapper that recognizes the `berry-admin` agent (labels.role ===
// 'a8s-admin') and prepares it to operate the cluster.
//
// Old design (removed): this injected 10 hardcoded cluster-admin tools
// (cluster_report / drain_worker / ...) as hostTools. That put cluster-ops
// *semantics* into the execution layer. Per 新-2 (docs/env-hand-skill-cli-memo.md),
// operating a8s is *knowledge*, not a built-in capability — so the admin
// agent now gets a generic shell Hand (it already has one) plus an `a8s-ops`
// skill, and runs the `berry-a8s-ops` CLI. The agent's tool surface no
// longer carries cluster semantics.
//
// What this wrapper does now:
//   1. Seeds the admin agent's home (default AGENTS.md + a8s-ops &
//      install-worker skills) on first boot, on the worker's own disk.
//   2. Injects BERRY_A8S_URL / BERRY_A8S_ADMIN_TOKEN into the agent's
//      execution environment so the CLI can authenticate — scoped to the
//      a8s-admin label only (see admin-ops-env.ts for the security note).
//
// Why here (not a8s-server): "berry-admin" is a *product* running on a8s,
// not a8s itself. The worker that mounts the agent is the right place for
// per-agent wiring, and it already holds the admin token (join handshake).

import { seedAdminAgentHome } from '@berry-agent/a8s-admin';
import type { WorkerAgentSpec } from '@berry-agent/worker';
import { createCredentialInjectingProvider } from './admin-ops-env.js';
import type { WireResolveInput } from './team-mode.js';

export interface AdminOpsModeResolverOptions {
  /** Base URL of the a8s control plane. */
  a8sUrl: string;
  /** Admin token — same one used for register handshake. */
  adminToken: string;
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
}

/**
 * Wrap a resolveSpec so any wire spec with `labels.role === 'a8s-admin'`
 * gets (a) its home seeded with the admin prompt + ops skills, and (b) the
 * a8s URL + admin token injected into its execution environment so the
 * `berry-a8s-ops` CLI can authenticate. No tools are added — the agent
 * operates the cluster through its shell Hand + the ops skill.
 *
 * Hosts that don't run an admin agent leave this off; the berry-worker CLI
 * applies it by default whenever an admin token is configured. No-op for
 * agents that don't carry the label.
 */
export function withAdminOpsEnv(
  baseResolve: (wire: WireResolveInput) => WorkerAgentSpec,
  options: AdminOpsModeResolverOptions,
): (wire: WireResolveInput) => WorkerAgentSpec {
  return (wire) => {
    const baseSpec = baseResolve(wire);
    if (wire.labels?.role !== 'a8s-admin') return baseSpec;
    // First-boot: seed default AGENTS.md + ops skills if absent. Idempotent.
    // Runs at the physical host so the data lives where the agent does.
    seedAdminAgentHome(baseSpec.workspace);
    return {
      ...baseSpec,
      executionEnvironmentProvider: createCredentialInjectingProvider(
        baseSpec.executionEnvironmentProvider,
        { BERRY_A8S_URL: options.a8sUrl, BERRY_A8S_ADMIN_TOKEN: options.adminToken },
      ),
    };
  };
}
