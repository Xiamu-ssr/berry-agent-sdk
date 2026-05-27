// ============================================================
// SqliteRuntimeOrchestrationStore tests
// ============================================================
// Uses ':memory:' database — no filesystem, no external service.
// The store is exercised against the same RuntimeOrchestrator state
// machines that MemoryRuntimeOrchestrationStore handles, so a passing
// run here means the contract is upheld.

import { describe, expect, it } from 'vitest';
import { RuntimeOrchestrator } from '@berry-agent/runtime';
import { SqliteRuntimeOrchestrationStore } from '../store.js';

function makeStore(): SqliteRuntimeOrchestrationStore {
  return new SqliteRuntimeOrchestrationStore({ dbPath: ':memory:' });
}

describe('SqliteRuntimeOrchestrationStore', () => {
  it('round-trips an empty snapshot', async () => {
    const store = makeStore();
    const snap = await store.load();
    expect(snap).toEqual({ leases: [], wakes: [], workers: [] });
    store.close();
  });

  it('persists leases through a RuntimeOrchestrator', async () => {
    const store = makeStore();
    const orchestrator = new RuntimeOrchestrator({ store });

    const result = await orchestrator.acquireLease({
      agentId: 'a1',
      holderId: 'host-A',
      ttlMs: 60_000,
    });
    expect(result.acquired).toBe(true);

    const all = await orchestrator.listLeases();
    expect(all).toHaveLength(1);
    expect(all[0].agentId).toBe('a1');
    store.close();
  });

  it('persists worker registry across simulated process boundary', async () => {
    const store = makeStore();
    const orchestrator = new RuntimeOrchestrator({ store });

    const worker = await orchestrator.registerWorker({
      holderId: 'process-1',
      capacity: 4,
      heartbeatTtlMs: 30_000,
    });
    expect(worker.state).toBe('active');

    // Simulate a fresh orchestrator over the same store — should read the
    // registered worker.
    const orchestrator2 = new RuntimeOrchestrator({ store });
    const list = await orchestrator2.listWorkers();
    expect(list).toHaveLength(1);
    expect(list[0].workerId).toBe(worker.workerId);
    store.close();
  });

  it('wake schedule + claim survives store reload', async () => {
    const store = makeStore();
    let now = 1000;
    const orchestrator = new RuntimeOrchestrator({ store, now: () => now });

    await orchestrator.scheduleWake({
      agentId: 'a1',
      dueAt: 2000,
      reason: 'test',
    });

    const orchestrator2 = new RuntimeOrchestrator({ store, now: () => now });
    expect(await orchestrator2.listPendingWakes()).toHaveLength(1);

    now = 2500;
    const claimed = await orchestrator2.claimDueWakes();
    expect(claimed).toHaveLength(1);
    expect(claimed[0].state).toBe('claimed');

    // Original orchestrator sees the same state
    const stillPending = await orchestrator.listPendingWakes(now);
    expect(stillPending).toHaveLength(0);
    store.close();
  });

  it('two RuntimeOrchestrators competing on the same store serialize', async () => {
    const store = makeStore();
    const orchestrator1 = new RuntimeOrchestrator({ store });
    const orchestrator2 = new RuntimeOrchestrator({ store });

    const a = await orchestrator1.acquireLease({
      agentId: 'shared',
      holderId: 'p1',
      ttlMs: 60_000,
    });
    expect(a.acquired).toBe(true);

    const b = await orchestrator2.acquireLease({
      agentId: 'shared',
      holderId: 'p2',
      ttlMs: 60_000,
    });
    expect(b.acquired).toBe(false);
    if (!b.acquired) {
      expect(b.active.holderId).toBe('p1');
    }
    store.close();
  });

  it('ensureSchema is idempotent', async () => {
    const store = makeStore();
    store.ensureSchema();
    store.ensureSchema();
    store.ensureSchema();
    const snap = await store.load();
    expect(snap).toEqual({ leases: [], wakes: [], workers: [] });
    store.close();
  });
});
