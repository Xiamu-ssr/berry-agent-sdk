// ============================================================
// @berry-agent/a8s-server — admin-agent bootstrap helper
// ============================================================
//
// ensureAdminAgent — make sure a 'berry-admin' agent is scheduled onto
// *some* active worker, carrying `labels.role = 'a8s-admin'`. The worker
// that mounts it injects the cluster-admin tools and seeds the default
// AGENTS.md (both via its resolveSpec). a8s-server never touches the
// agent's on-disk home — that lives on the worker's machine. The human
// operator (or the UI's "Bootstrap admin agent" button) drives the
// cluster through this agent instead of curl-ing /v1/operator/* by hand.
//
// This is a pure control-plane operation: it's just createAgent with a
// label. a8s itself runs no worker and no agent — berry-admin is an
// ordinary agent that the scheduler places on whatever worker exists.
// Idempotent: short-circuits when the agent is already assigned.

import { type ControlPlane, type WireWorkerAgentSpec } from '@berry-agent/a8s';

export interface AdminAgentConfig {
  /** Stable agent id; default 'berry-admin'. */
  agentId?: string;
  /** Main model ref. Default 'tier:strong' when the operator doesn't pick one. */
  model?: string;
  /** Auto-approval classifier model. Omitted → SDK default. */
  classifierModel?: string;
}

/**
 * Ensure the berry-admin agent is scheduled onto an active worker.
 * Idempotent: short-circuits when the agent is already assigned.
 *
 * Stamps `labels.role = 'a8s-admin'`, which is the entire wiring story —
 * whichever worker the scheduler picks sees that label and (via its
 * resolveSpec) injects the cluster-admin tools and seeds the default
 * AGENTS.md on the worker's own filesystem. a8s-server neither imports
 * cluster-admin code nor touches the agent's on-disk home.
 *
 * `workspace` is intentionally the bare agentId — each worker resolves
 * it against its own machine-scoped agentsRoot. Returns the agentId.
 *
 * Throws (via createAgent) when no worker has capacity — surfaced to the
 * UI as "deploy a worker first".
 */
export async function ensureAdminAgent(
  plane: ControlPlane,
  config: AdminAgentConfig = {},
): Promise<string> {
  const agentId = config.agentId ?? 'berry-admin';

  if (plane.getAgentLocation(agentId).workerId != null) {
    return agentId;
  }

  const spec: WireWorkerAgentSpec = {
    agentId,
    workspace: agentId,
    model: config.model ?? 'tier:strong',
    ...(config.classifierModel ? { classifierModel: config.classifierModel } : {}),
    ensureDefaultMcpConfig: false,
    labels: { role: 'a8s-admin' },
  };
  const result = await plane.createAgent(spec, { tag: 'admin-bootstrap' });

  // Persist a lease so the assignment survives an a8s restart with a
  // durable store (same TTL the agent-create route uses).
  await plane.orchestrator.acquireLease({
    agentId: result.agentId,
    holderId: result.workerId,
    workerId: result.workerId,
    ttlMs: 5 * 60_000,
  });

  return agentId;
}
