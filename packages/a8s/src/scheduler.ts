// ============================================================
// @berry-agent/a8s — Schedulers
// ============================================================
// Decides which worker should run a new agent. ControlPlane treats this
// as a pluggable strategy so production deployments can override the
// default (least-loaded) with priority/affinity/cost-aware policies.

import type { WorkerNode, WorkerNodeCapacity } from './worker-node.js';

export interface SchedulerContext<TEntry> {
  agentId: string;
  entry: TEntry;
  workers: ReadonlyArray<SchedulerWorkerView<TEntry>>;
}

export interface SchedulerWorkerView<TEntry> {
  node: WorkerNode<TEntry>;
  capacity: WorkerNodeCapacity;
}

export interface Scheduler<TEntry = unknown> {
  pick(ctx: SchedulerContext<TEntry>): WorkerNode<TEntry> | null | Promise<WorkerNode<TEntry> | null>;
}

/**
 * Default scheduler — picks the worker with the most available capacity,
 * skipping workers whose capacity is full. Ties break on insertion order.
 */
export const leastLoadedScheduler: Scheduler<unknown> = {
  pick(ctx) {
    let bestNode: WorkerNode<unknown> | null = null;
    let bestAvailable = -1;
    for (const { node, capacity } of ctx.workers) {
      const available = capacity.total === Number.POSITIVE_INFINITY
        ? Number.POSITIVE_INFINITY
        : capacity.total - capacity.used;
      if (available <= 0) continue;
      if (available > bestAvailable) {
        bestAvailable = available;
        bestNode = node;
      }
    }
    return bestNode;
  },
};

/**
 * Round-robin scheduler — useful for tests and quick balancing without
 * caring about capacity numbers.
 */
export function createRoundRobinScheduler<TEntry>(): Scheduler<TEntry> {
  let cursor = 0;
  return {
    pick(ctx) {
      if (ctx.workers.length === 0) return null;
      const start = cursor;
      for (let i = 0; i < ctx.workers.length; i++) {
        const idx = (start + i) % ctx.workers.length;
        const { node, capacity } = ctx.workers[idx];
        const available = capacity.total === Number.POSITIVE_INFINITY
          ? Number.POSITIVE_INFINITY
          : capacity.total - capacity.used;
        if (available > 0) {
          cursor = (idx + 1) % ctx.workers.length;
          return node;
        }
      }
      return null;
    },
  };
}
