// ============================================================
// @berry-agent/a8s-admin — cluster-admin Hand
// ============================================================
// Exposes a8s operator endpoints as model-visible tools so a berry agent
// can answer "what's running where?" / "drain the busy worker" / "show
// me cluster capacity" without the human ever opening a CLI.
//
// Design note: every capability is intentionally small and read-mostly.
// Destructive operations (evict, drain) live behind the same Hand but
// the SDK's tool-guard + approval layer is where dangerous calls get
// rate-limited. We don't bake a confirmation prompt into the tool
// description because that's the host product's job.

import { createToolRegistrationHand, type Hand, type ToolRegistration } from '@berry-agent/core';
import type { A8sOperatorClient } from './operator-client.js';

export interface ClusterAdminHandOptions {
  client: A8sOperatorClient;
  /** Override hand id; defaults to 'cluster-admin'. */
  id?: string;
}

export function createClusterAdminHand(options: ClusterAdminHandOptions): Hand {
  const client = options.client;

  const tools: ToolRegistration[] = [
    {
      definition: {
        name: 'cluster_report',
        description: 'Return a high-level snapshot of the a8s cluster: worker counts by state, total/used/available capacity, agent count, and uptime. Use this first when answering "how is the cluster doing?".',
        inputSchema: { type: 'object', properties: {} },
      },
      execute: async () => {
        const report = await client.clusterReport();
        return { content: JSON.stringify(report, null, 2) };
      },
    },
    {
      definition: {
        name: 'list_workers',
        description: 'List every worker the cluster knows about, including state (active/draining/evicted/withdrawn), capacity, currently-used slots, callback URL, labels, and registration/heartbeat timestamps.',
        inputSchema: { type: 'object', properties: {} },
      },
      execute: async () => {
        const { workers } = await client.listWorkers();
        return { content: JSON.stringify(workers, null, 2) };
      },
    },
    {
      definition: {
        name: 'list_agents',
        description: 'List every agent currently assigned to a worker. Returns { agentId, workerId } pairs. Useful for "what is running?" and for choosing a target before drain/evict.',
        inputSchema: { type: 'object', properties: {} },
      },
      execute: async () => {
        const { agents } = await client.listAgents();
        return { content: JSON.stringify(agents, null, 2) };
      },
    },
    {
      definition: {
        name: 'list_leases',
        description: 'List the durable lease table from the orchestration store. Each row binds an agent to the worker currently authorized to run it, with acquired/renewed/expires timestamps. Use this to debug "where should agent X be?" or to spot stuck/expired leases.',
        inputSchema: { type: 'object', properties: {} },
      },
      execute: async () => {
        const { leases } = await client.listLeases();
        return { content: JSON.stringify(leases, null, 2) };
      },
    },
    {
      definition: {
        name: 'drain_worker',
        description: 'Mark a worker as draining: it keeps running its current agents but will not be picked for new placements. Reversible via undrain_worker. Use before a planned restart or upgrade.',
        inputSchema: {
          type: 'object',
          properties: {
            workerId: { type: 'string', description: 'The workerId from list_workers.' },
          },
          required: ['workerId'],
        },
      },
      execute: async (input) => {
        const id = String(input.workerId ?? '').trim();
        if (!id) return { content: 'workerId is required', isError: true };
        await client.drainWorker(id);
        return { content: `worker "${id}" drained` };
      },
    },
    {
      definition: {
        name: 'undrain_worker',
        description: 'Re-enable a previously drained worker so the scheduler picks it again. Use after the planned-restart window closes.',
        inputSchema: {
          type: 'object',
          properties: {
            workerId: { type: 'string', description: 'The workerId from list_workers.' },
          },
          required: ['workerId'],
        },
      },
      execute: async (input) => {
        const id = String(input.workerId ?? '').trim();
        if (!id) return { content: 'workerId is required', isError: true };
        await client.undrainWorker(id);
        return { content: `worker "${id}" undrained` };
      },
    },
    {
      definition: {
        name: 'evict_worker',
        description: 'Hard-remove a worker from the cluster: stop routing to it, release all its leases, free its slots for re-scheduling on other workers. **Destructive — agents on the evicted worker stop until rescheduled.** Use for unrecoverable workers (network partition, crashed host). Prefer drain_worker for planned maintenance.',
        inputSchema: {
          type: 'object',
          properties: {
            workerId: { type: 'string', description: 'The workerId from list_workers.' },
          },
          required: ['workerId'],
        },
      },
      execute: async (input) => {
        const id = String(input.workerId ?? '').trim();
        if (!id) return { content: 'workerId is required', isError: true };
        await client.evictWorker(id);
        return { content: `worker "${id}" evicted; leases released` };
      },
    },
    {
      definition: {
        name: 'worker_join_script',
        description: 'Generate a bash snippet the operator pastes into an SSH session on a new host to install + start a worker that joins this cluster. Optional inputs let you preset workerId (defaults to the target hostname), capacity (default 4), port (default 7100), or labels. The returned script embeds the cluster admin token, so treat the output as a secret — show it only to the operator, never log it.',
        inputSchema: {
          type: 'object',
          properties: {
            workerId: { type: 'string', description: 'Override the worker id; defaults to $(hostname) on the target.' },
            capacity: { type: 'number', description: 'Max concurrent agents this worker accepts. Default 4.' },
            port: { type: 'number', description: 'HTTP port the worker daemon listens on. Default 7100.' },
            bindHost: { type: 'string', description: 'Hostname/IP the worker advertises back to a8s. Default $(hostname).' },
            dataRoot: { type: 'string', description: 'Override the worker data dir; default /var/berry/workers/<workerId>.' },
          },
        },
      },
      execute: async (input) => {
        const req: Record<string, unknown> = {};
        if (typeof input.workerId === 'string' && input.workerId.trim()) req.workerId = input.workerId.trim();
        if (typeof input.capacity === 'number') req.capacity = input.capacity;
        if (typeof input.port === 'number') req.port = input.port;
        if (typeof input.bindHost === 'string' && input.bindHost.trim()) req.bindHost = input.bindHost.trim();
        if (typeof input.dataRoot === 'string' && input.dataRoot.trim()) req.dataRoot = input.dataRoot.trim();
        try {
          const result = await client.joinScript(req as Parameters<typeof client.joinScript>[0]);
          return {
            content: `Resolved config:\n${JSON.stringify(result.resolved, null, 2)}\n\n--- Paste the following on the new host (it embeds the cluster admin token; do not log) ---\n\n${result.script}`,
          };
        } catch (err) {
          return { content: err instanceof Error ? err.message : String(err), isError: true };
        }
      },
    },
  ];

  return createToolRegistrationHand({
    id: options.id ?? 'cluster-admin',
    kind: 'local',
    displayName: 'a8s cluster administration',
    tools,
  });
}
