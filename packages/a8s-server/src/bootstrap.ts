// ============================================================
// @berry-agent/a8s-server — startup bootstrap helpers
// ============================================================
//
// Two opt-in helpers that make a fresh `berry-a8s start` usable
// without a separate worker deployment:
//
//   - ensureLocalWorker  — boot an in-process Worker on the same host as
//     a8s, register it with the orchestrator + plane. Co-located failure
//     domain: when a8s dies, this worker dies too. That's fine for the
//     berry-admin agent (which is what this is mostly for) — production
//     agents should live on workers deployed on other machines.
//
//   - ensureAdminAgent   — make sure a 'berry-admin' agent is scheduled
//     onto *some* active worker, carrying `labels.role = 'a8s-admin'`.
//     The worker that mounts it injects the cluster-admin tools and
//     seeds the default AGENTS.md (both via its resolveSpec). a8s-server
//     never touches the agent's on-disk home — that lives on the worker's
//     machine. The human operator (or the UI) then chats with this agent
//     to drive the cluster instead of curl-ing /v1/operator/* by hand.
//
// Both are idempotent on restart — registerWorker uses a stable id and
// ensureAdminAgent short-circuits when the agent is already assigned.

import { mkdirSync } from 'node:fs';
import { hostname } from 'node:os';
import { AgentHome } from '@berry-agent/core';
import { InProcessWorkerNode, type ControlPlane, type WireWorkerAgentSpec } from '@berry-agent/a8s';
import { Worker, type WorkerAgentSpec, type WorkerEnvironment } from '@berry-agent/worker';
import { A8sOperatorClient, buildClusterAdminTools, seedAdminAgentHome } from '@berry-agent/a8s-admin';
import type { A8sServer } from './server.js';

export interface LocalWorkerConfig {
  /** Stable id; default 'a8s-local'. Survives a8s restarts. */
  workerId?: string;
  /** Concurrent agent slots; default 4. */
  capacity?: number;
  /**
   * Root for the worker's *private* data (observe.db, logs). Does NOT
   * hold agent homes — those live under agentsRoot, machine-scoped.
   * Default `/var/berry/a8s/local-worker`.
   */
  dataRoot?: string;
  /**
   * Root for agent home directories, machine-scoped. Default
   * `/var/berry/agents`. Sharing this with other workers on the same
   * machine is intentional: it lets agents survive worker process
   * crashes without data movement.
   */
  agentsRoot?: string;
  /**
   * Machine identifier stamped into the worker's labels.machine. The
   * a8s scheduler treats workers sharing a machine value as failover
   * peers (an agent stranded by a dead worker is preferentially
   * re-mounted on another worker with the same machine label).
   * Default os.hostname().
   */
  machine?: string;
  /** Heartbeat TTL in ms. Default 30 000. */
  heartbeatTtlMs?: number;
  /** Additional labels. `machine` and `role` are stamped automatically. */
  labels?: Readonly<Record<string, string>>;
  /** SDK runtime environment — registry / credentials / observer. Required. */
  env: WorkerEnvironment;
}

export interface AdminAgentConfig {
  /** Stable agent id; default 'berry-admin'. */
  agentId?: string;
  /** Model ref; default 'tier:strong'. */
  model?: string;
}

/**
 * Spin up an in-process worker and register it with this a8s server.
 * Returns the Worker (the caller rarely needs it now — scheduling goes
 * through the plane, not the worker handle).
 *
 * `adminToken` enables the same cluster-admin label-injection that
 * external worker daemons get — agents created with
 * `labels.role === 'a8s-admin'` get the cluster-admin Hand tools
 * auto-mounted via the worker node's resolveSpec hook. Passing it is
 * required if this local worker is to host the berry-admin agent.
 */
export async function ensureLocalWorker(
  server: A8sServer,
  config: LocalWorkerConfig & { adminToken?: string; a8sUrl?: string; a8sPort?: number },
): Promise<Worker> {
  const workerId = config.workerId ?? 'a8s-local';
  const capacity = config.capacity ?? 4;
  const heartbeatTtlMs = config.heartbeatTtlMs ?? 30_000;
  const dataRoot = config.dataRoot ?? '/var/berry/a8s/local-worker';
  const agentsRoot = config.agentsRoot ?? '/var/berry/agents';
  const machine = config.machine ?? hostname();

  mkdirSync(dataRoot, { recursive: true });
  mkdirSync(agentsRoot, { recursive: true });

  const worker = new Worker({ env: config.env });

  // 1. Durable side: insert into orchestrator so cluster reports + lease
  //    acquisition see this worker. Always stamp the machine + role
  //    labels so same-machine failover affinity has data to work with.
  await server.plane.orchestrator.registerWorker({
    workerId,
    holderId: workerId,
    capacity,
    heartbeatTtlMs,
    labels: { ...(config.labels ?? {}), role: 'a8s-local', machine },
  });

  // 2. In-memory side: add a WorkerNode so the plane's data-plane
  //    routing can reach it without HTTP. The resolveSpec hook applies
  //    label conventions identical to the worker daemon — agents
  //    arriving with `labels.role === 'a8s-admin'` get the cluster-
  //    admin Hand auto-mounted (no a8s-server → a8s-admin coupling).
  const a8sUrl = config.a8sUrl ?? `http://localhost:${config.a8sPort ?? server.port}`;
  const resolveSpec = config.adminToken
    ? makeAdminAwareResolveSpec({
        a8sUrl,
        adminToken: config.adminToken,
        agentsRoot,
      })
    : undefined;
  server.plane.addWorker(new InProcessWorkerNode(workerId, worker, { resolveSpec }));

  return worker;
}

/**
 * Build a resolveSpec that injects the cluster-admin Hand for any
 * spec carrying `labels.role === 'a8s-admin'`. Defined here (not in
 * worker-daemon) because the local worker doesn't go through the
 * daemon CLI — it builds its own resolveSpec chain inline.
 */
function makeAdminAwareResolveSpec(opts: { a8sUrl: string; adminToken: string; agentsRoot: string }) {
  const baseResolve = (wire: WireWorkerAgentSpec): WorkerAgentSpec => {
    const workspace = wire.workspace.includes('/') || wire.workspace.includes('\\')
      ? wire.workspace
      : `${opts.agentsRoot}/${wire.workspace}`;
    return {
      agentId: wire.agentId,
      workspace,
      home: new AgentHome(workspace),
      projectRoot: wire.projectRoot,
      model: wire.model,
      reasoningEffort: wire.reasoningEffort as WorkerAgentSpec['reasoningEffort'],
      toolDenylist: wire.toolDenylist,
      ensureDefaultMcpConfig: wire.ensureDefaultMcpConfig,
    };
  };
  const client = new A8sOperatorClient({ a8sUrl: opts.a8sUrl, adminToken: opts.adminToken });
  const adminTools = buildClusterAdminTools(client);
  return (wire: WireWorkerAgentSpec): WorkerAgentSpec => {
    const base = baseResolve(wire);
    if (wire.labels?.role !== 'a8s-admin') return base;
    // First-boot: seed default AGENTS.md if absent. Same single-source
    // helper the worker daemon uses; runs here because the in-process
    // worker shares this host's filesystem.
    seedAdminAgentHome(base.workspace);
    const existing = Array.from(base.hostTools ?? []);
    const existingNames = new Set(existing.map((t) => t.definition.name));
    const additions = adminTools.filter((t) => !existingNames.has(t.definition.name));
    return {
      ...base,
      hostTools: [...existing, ...additions],
      hostHandDisplayName: base.hostHandDisplayName ?? 'a8s cluster administration',
    };
  };
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
 */
export async function ensureAdminAgent(
  plane: ControlPlane,
  config: AdminAgentConfig = {},
): Promise<string> {
  const agentId = config.agentId ?? 'berry-admin';

  // Already scheduled? Nothing to do. Runs on every a8s start.
  if (plane.getAgentLocation(agentId).workerId != null) {
    return agentId;
  }

  const spec: WireWorkerAgentSpec = {
    agentId,
    workspace: agentId,
    model: config.model ?? 'tier:strong',
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
