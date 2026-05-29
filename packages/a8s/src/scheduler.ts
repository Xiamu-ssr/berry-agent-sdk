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
  /**
   * Soft hint: when set, the scheduler prefers a worker whose
   * `labels.machine` equals this value, falling back to its normal
   * policy if none is available. Set by ControlPlane.createAgent when
   * the caller wants same-host failover affinity (an agent's on-disk
   * data lives on a specific machine, so re-mounting on that same host
   * means zero data movement).
   */
  preferredMachine?: string;
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
 *
 * When `preferredMachine` is set, the same selection runs first against
 * the subset of workers on that machine; if any qualifies, it wins.
 * Otherwise we fall back to the full pool. This is the cluster-wide
 * "stay on the same host after a process restart" affinity rule.
 *
 * Exposed as a factory (instead of a singleton) so callers can use it
 * under a typed entry shape without unsafe casts.
 */
export function createLeastLoadedScheduler<TEntry>(): Scheduler<TEntry> {
  return {
    pick(ctx) {
      if (ctx.preferredMachine) {
        const sameMachine = ctx.workers.filter(
          (w) => w.node.labels?.machine === ctx.preferredMachine,
        );
        const onMachine = pickLeastLoaded(sameMachine);
        if (onMachine) return onMachine;
      }
      return pickLeastLoaded(ctx.workers);
    },
  };
}

function pickLeastLoaded<TEntry>(
  views: ReadonlyArray<SchedulerWorkerView<TEntry>>,
): WorkerNode<TEntry> | null {
  let bestNode: WorkerNode<TEntry> | null = null;
  let bestAvailable = -1;
  for (const { node, capacity } of views) {
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
}

/**
 * Round-robin scheduler — useful for tests and quick balancing without
 * caring about capacity numbers. Does NOT honour preferredMachine
 * (round-robin's whole point is to ignore affinity).
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
