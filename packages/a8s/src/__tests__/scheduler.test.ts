// ============================================================
// @berry-agent/a8s — Scheduler unit tests
// ============================================================
// The schedulers themselves are pure functions over the
// SchedulerContext shape. We feed synthetic worker views (no real
// Worker instance needed) so the tests stay focused on selection
// policy.

import { describe, expect, it } from 'vitest';
import { createLeastLoadedScheduler, createRoundRobinScheduler } from '../scheduler.js';
import type { WorkerNode, WorkerNodeCapacity } from '../worker-node.js';

interface StubLabels { machine?: string }

function stubNode(workerId: string, labels?: StubLabels): WorkerNode {
  return {
    workerId,
    labels,
    capacity: async () => ({ used: 0, total: 0 }),
    has: async () => false,
    runAgent: async () => {},
    stopAgent: async () => {},
    openSession: async () => undefined,
  };
}

function view(node: WorkerNode, used: number, total: number) {
  const capacity: WorkerNodeCapacity = { used, total };
  return { node, capacity };
}

describe('createLeastLoadedScheduler', () => {
  it('picks the worker with the most free capacity', () => {
    const sched = createLeastLoadedScheduler();
    const a = stubNode('a');
    const b = stubNode('b');
    const c = stubNode('c');
    const pick = sched.pick({
      agentId: 'x', entry: undefined,
      workers: [view(a, 3, 4), view(b, 0, 4), view(c, 2, 4)],
    });
    expect(pick).toBe(b);
  });

  it('skips workers at capacity', () => {
    const sched = createLeastLoadedScheduler();
    const a = stubNode('a');
    const b = stubNode('b');
    const pick = sched.pick({
      agentId: 'x', entry: undefined,
      workers: [view(a, 4, 4), view(b, 1, 4)],
    });
    expect(pick).toBe(b);
  });

  it('returns null when no worker has capacity', () => {
    const sched = createLeastLoadedScheduler();
    const pick = sched.pick({
      agentId: 'x', entry: undefined,
      workers: [view(stubNode('a'), 4, 4)],
    });
    expect(pick).toBeNull();
  });

  it('preferredMachine wins over capacity when a same-machine worker is available', () => {
    const sched = createLeastLoadedScheduler();
    const sameButTight = stubNode('a', { machine: 'm1' });
    const otherButRoomy = stubNode('b', { machine: 'm2' });
    const pick = sched.pick({
      agentId: 'x', entry: undefined,
      preferredMachine: 'm1',
      workers: [view(sameButTight, 3, 4), view(otherButRoomy, 0, 4)],
    });
    expect(pick).toBe(sameButTight);
  });

  it('falls back to global least-loaded when no same-machine worker has capacity', () => {
    const sched = createLeastLoadedScheduler();
    const sameButFull = stubNode('a', { machine: 'm1' });
    const otherWithRoom = stubNode('b', { machine: 'm2' });
    const pick = sched.pick({
      agentId: 'x', entry: undefined,
      preferredMachine: 'm1',
      workers: [view(sameButFull, 4, 4), view(otherWithRoom, 1, 4)],
    });
    expect(pick).toBe(otherWithRoom);
  });

  it('ignores preferredMachine when no worker has that label', () => {
    const sched = createLeastLoadedScheduler();
    const a = stubNode('a', { machine: 'm-other' });
    const b = stubNode('b');
    const pick = sched.pick({
      agentId: 'x', entry: undefined,
      preferredMachine: 'm-ghost',
      workers: [view(a, 3, 4), view(b, 0, 4)],
    });
    expect(pick).toBe(b);
  });
});

describe('createRoundRobinScheduler', () => {
  it('cycles through workers', () => {
    const sched = createRoundRobinScheduler();
    const a = stubNode('a');
    const b = stubNode('b');
    const ctx = { agentId: 'x', entry: undefined, workers: [view(a, 0, 4), view(b, 0, 4)] };
    expect(sched.pick(ctx)).toBe(a);
    expect(sched.pick(ctx)).toBe(b);
    expect(sched.pick(ctx)).toBe(a);
  });

  it('ignores preferredMachine (by design)', () => {
    const sched = createRoundRobinScheduler();
    const a = stubNode('a', { machine: 'm-other' });
    const b = stubNode('b', { machine: 'm1' });
    const ctx = {
      agentId: 'x', entry: undefined,
      preferredMachine: 'm1',
      workers: [view(a, 0, 4), view(b, 0, 4)],
    };
    expect(sched.pick(ctx)).toBe(a); // round-robin pops first
  });
});
