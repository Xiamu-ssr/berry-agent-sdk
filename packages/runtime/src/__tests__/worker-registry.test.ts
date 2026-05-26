// ============================================================
// Worker registry tests
// ============================================================

import { describe, expect, it } from 'vitest';
import {
  MemoryRuntimeOrchestrationStore,
  RuntimeOrchestrator,
} from '../orchestration.js';

function makeOrchestrator(now = { value: 1000 }): {
  orchestrator: RuntimeOrchestrator;
  store: MemoryRuntimeOrchestrationStore;
  advance: (ms: number) => void;
} {
  const store = new MemoryRuntimeOrchestrationStore();
  const orchestrator = new RuntimeOrchestrator({
    store,
    now: () => now.value,
  });
  return {
    orchestrator,
    store,
    advance: (ms) => { now.value += ms; },
  };
}

describe('worker registry', () => {
  it('registers a worker and lists it', async () => {
    const { orchestrator } = makeOrchestrator();
    const worker = await orchestrator.registerWorker({
      holderId: 'host-1',
      capacity: 4,
      heartbeatTtlMs: 30_000,
    });
    expect(worker.state).toBe('active');
    expect(worker.capacity).toBe(4);

    const all = await orchestrator.listWorkers();
    expect(all).toHaveLength(1);
    expect(all[0].workerId).toBe(worker.workerId);
  });

  it('refreshes an existing worker on re-register', async () => {
    const { orchestrator } = makeOrchestrator();
    const first = await orchestrator.registerWorker({
      holderId: 'host-1',
      capacity: 2,
      heartbeatTtlMs: 10_000,
      workerId: 'fixed',
    });
    const second = await orchestrator.registerWorker({
      holderId: 'host-1',
      capacity: 5,
      heartbeatTtlMs: 10_000,
      workerId: 'fixed',
    });
    expect(second.workerId).toBe(first.workerId);
    expect(second.capacity).toBe(5);
    const all = await orchestrator.listWorkers();
    expect(all).toHaveLength(1);
  });

  it('rejects new leases on a draining worker', async () => {
    const { orchestrator } = makeOrchestrator();
    const worker = await orchestrator.registerWorker({
      holderId: 'host-1',
      capacity: 4,
      heartbeatTtlMs: 30_000,
    });
    await orchestrator.drainWorker(worker.workerId);
    await expect(orchestrator.acquireLease({
      agentId: 'agent-A',
      holderId: 'host-1',
      workerId: worker.workerId,
      ttlMs: 10_000,
    })).rejects.toThrow(/not accepting/);
  });

  it('enforces capacity for worker leases', async () => {
    const { orchestrator } = makeOrchestrator();
    const worker = await orchestrator.registerWorker({
      holderId: 'host-1',
      capacity: 1,
      heartbeatTtlMs: 30_000,
    });
    const first = await orchestrator.acquireLease({
      agentId: 'agent-A',
      holderId: 'host-1',
      workerId: worker.workerId,
      ttlMs: 10_000,
    });
    expect(first.acquired).toBe(true);
    await expect(orchestrator.acquireLease({
      agentId: 'agent-B',
      holderId: 'host-1',
      workerId: worker.workerId,
      ttlMs: 10_000,
    })).rejects.toThrow(/capacity/);
  });

  it('evicts workers whose heartbeat has expired and releases their leases', async () => {
    const now = { value: 1000 };
    const { orchestrator, advance } = makeOrchestrator(now);
    const worker = await orchestrator.registerWorker({
      holderId: 'host-1',
      capacity: 2,
      heartbeatTtlMs: 5_000,
    });
    await orchestrator.acquireLease({
      agentId: 'agent-A',
      holderId: 'host-1',
      workerId: worker.workerId,
      ttlMs: 60_000,
    });
    advance(6_000);
    const result = await orchestrator.evictStaleWorkers();
    expect(result.evicted).toHaveLength(1);
    expect(result.evicted[0].state).toBe('evicted');
    expect(result.releasedLeases).toHaveLength(1);
    expect(result.releasedLeases[0].state).toBe('expired');

    // The agent should now be re-acquirable on a healthy worker
    const fresh = await orchestrator.registerWorker({
      holderId: 'host-2',
      capacity: 1,
      heartbeatTtlMs: 30_000,
    });
    const reacquired = await orchestrator.acquireLease({
      agentId: 'agent-A',
      holderId: 'host-2',
      workerId: fresh.workerId,
      ttlMs: 10_000,
    });
    expect(reacquired.acquired).toBe(true);
  });

  it('heartbeat extends the expiry window', async () => {
    const now = { value: 1000 };
    const { orchestrator, advance } = makeOrchestrator(now);
    const worker = await orchestrator.registerWorker({
      holderId: 'host-1',
      capacity: 1,
      heartbeatTtlMs: 5_000,
    });
    advance(3_000);
    const refreshed = await orchestrator.heartbeatWorker(worker.workerId, 10_000);
    expect(refreshed).not.toBeNull();
    expect(refreshed!.heartbeatExpiresAt).toBe(now.value + 10_000);
    advance(6_000);
    const result = await orchestrator.evictStaleWorkers();
    expect(result.evicted).toHaveLength(0);
  });

  it('withdraws a worker and releases its leases', async () => {
    const { orchestrator } = makeOrchestrator();
    const worker = await orchestrator.registerWorker({
      holderId: 'host-1',
      capacity: 2,
      heartbeatTtlMs: 30_000,
    });
    await orchestrator.acquireLease({
      agentId: 'agent-A',
      holderId: 'host-1',
      workerId: worker.workerId,
      ttlMs: 60_000,
    });
    const result = await orchestrator.withdrawWorker(worker.workerId);
    expect(result?.evicted[0].state).toBe('withdrawn');
    expect(result?.releasedLeases).toHaveLength(1);
  });

  it('workerCapacityReport reflects active leases', async () => {
    const { orchestrator } = makeOrchestrator();
    const worker = await orchestrator.registerWorker({
      holderId: 'host-1',
      capacity: 4,
      heartbeatTtlMs: 30_000,
    });
    await orchestrator.acquireLease({
      agentId: 'agent-A',
      holderId: 'host-1',
      workerId: worker.workerId,
      ttlMs: 10_000,
    });
    await orchestrator.acquireLease({
      agentId: 'agent-B',
      holderId: 'host-1',
      workerId: worker.workerId,
      ttlMs: 10_000,
    });
    const report = await orchestrator.workerCapacityReport();
    expect(report).toHaveLength(1);
    expect(report[0].activeLeases).toBe(2);
    expect(report[0].available).toBe(2);
  });

  it('legacy snapshots without workers field still parse', async () => {
    const { parseRuntimeOrchestrationSnapshot } = await import('../orchestration.js');
    const snapshot = parseRuntimeOrchestrationSnapshot(JSON.stringify({ leases: [], wakes: [] }));
    expect(snapshot.workers).toEqual([]);
  });
});
