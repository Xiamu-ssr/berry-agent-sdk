// ============================================================
// @berry-agent/a8s-server — startup bootstrap helpers
// ============================================================
//
// Two opt-in startup helpers that make a fresh `berry-a8s start` usable
// without a separate worker deployment:
//
//   - ensureLocalWorker  — boot an in-process Worker on the same host as
//     a8s, register it with the orchestrator + plane. Co-located failure
//     domain: when a8s dies, this worker dies too. That's fine for the
//     berry-admin agent (which is what this is mostly for) — production
//     agents should live on workers deployed on other machines.
//
//   - ensureAdminAgent   — make sure a 'berry-admin' agent is mounted on
//     the local worker, with the cluster-admin Hand installed. The
//     human operator (or the UI) chats with this agent to drive the
//     cluster instead of curl-ing /v1/operator/* by hand.
//
// Both are idempotent on restart — registerWorker uses a stable id and
// createAgent short-circuits when an active lease already binds the
// agent to a worker.

import { mkdirSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { AgentHome } from '@berry-agent/core';
import { InProcessWorkerNode } from '@berry-agent/a8s';
import { Worker, type WorkerAgentSpec, type WorkerEnvironment } from '@berry-agent/worker';
import { A8sOperatorClient, createClusterAdminHand } from '@berry-agent/a8s-admin';
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
  /** Override the built-in system prompt. */
  systemPrompt?: string;
  /** a8s URL the admin agent's cluster-admin hand should hit. Default 'http://localhost:<a8sPort>'. */
  a8sUrl?: string;
}

export interface BootstrapResult {
  worker: Worker;
  workerId: string;
  agentId: string;
}

/**
 * Spin up an in-process worker and register it with this a8s server.
 * Returns the Worker so the caller can later mount agents on it directly
 * (e.g. ensureAdminAgent) without going through HTTP.
 */
export async function ensureLocalWorker(
  server: A8sServer,
  config: LocalWorkerConfig,
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
  //    routing can reach it without HTTP.
  server.plane.addWorker(new InProcessWorkerNode(workerId, worker));

  return worker;
}

/**
 * Default system prompt for the berry-admin agent. Spelled out here so
 * a future skill / template package isn't required just to boot a8s.
 */
const DEFAULT_ADMIN_SYSTEM_PROMPT = `You are berry-admin, the cluster operator for this a8s control plane.

You have tools to inspect and operate the cluster (cluster_report, list_workers, list_agents, list_leases, drain_worker, undrain_worker, evict_worker, worker_join_script). You answer operator questions and execute cluster operations on their behalf.

Conventions:
- When the operator asks "how is the cluster?", start with cluster_report; then drill down with list_workers / list_agents if they want detail.
- Before any destructive operation (drain / evict), confirm the workerId with list_workers and state what will happen ("evicting worker-b will release N agents; they need to be re-scheduled"). Then call the tool.
- Prefer drain_worker over evict_worker for planned maintenance. evict_worker is for unrecoverable hosts.
- When the operator asks "how do I add a worker?", use worker_join_script and present the returned snippet verbatim. The snippet embeds the cluster admin token — never log it.
- Use plain English in responses; show JSON only when the operator asks for the raw shape.
- You are the only agent that can run these tools — keep it boring, predictable, and explicit.
`;

/**
 * Ensure the berry-admin agent exists, is mounted on the given worker,
 * and has the cluster-admin hand installed. Idempotent.
 *
 * `agentsRoot` must match what was passed to ensureLocalWorker so the
 * agent home lives at the machine-scoped location.
 */
export async function ensureAdminAgent(
  server: A8sServer,
  worker: Worker,
  agentsRoot: string,
  adminToken: string,
  config: AdminAgentConfig & { a8sPort: number },
): Promise<string> {
  const agentId = config.agentId ?? 'berry-admin';
  const workspace = join(agentsRoot, agentId);
  const home = new AgentHome(workspace);
  await home.ensure();

  // Mount via the plane so the assignment + lease are persisted
  // through the same path human-created agents take. Skip if the agent
  // is already mounted on this worker — bootstrap runs on every a8s
  // start, and createAgent is not idempotent on its own.
  const existingLocation = server.plane.getAgentLocation(agentId);
  if (existingLocation.workerId == null) {
    const spec: WorkerAgentSpec = {
      agentId,
      workspace,
      home,
      model: config.model ?? 'tier:strong',
      ensureDefaultMcpConfig: false,
    };
    await server.plane.createAgent(spec, { tag: 'admin-bootstrap' });
  }

  const mount = worker.get(agentId);
  if (!mount) {
    // createAgent should have placed it on our local worker (only option),
    // but defend against a future scheduler that picks differently.
    throw new Error(`ensureAdminAgent: agent ${agentId} was not mounted on the local worker after createAgent`);
  }

  // Install (or replace) the cluster-admin hand. Doing this every
  // startup is fine — addHand is idempotent on hand id.
  if (!mount.runtime.hasHand?.('cluster-admin')) {
    const client = new A8sOperatorClient({
      a8sUrl: config.a8sUrl ?? `http://localhost:${config.a8sPort}`,
      adminToken,
    });
    mount.runtime.addHand(createClusterAdminHand({ client }));
  }

  // Seed AGENTS.md only on first boot so an operator who has customized
  // it doesn't get clobbered.
  await writeIfMissing(home.agentMdPath, config.systemPrompt ?? DEFAULT_ADMIN_SYSTEM_PROMPT);

  return agentId;
}

async function writeIfMissing(path: string, content: string): Promise<void> {
  const { writeFile, access } = await import('node:fs/promises');
  try {
    await access(path);
    return; // already exists
  } catch {
    await writeFile(path, content, 'utf-8');
  }
}
