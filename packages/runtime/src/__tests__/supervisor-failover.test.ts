// ============================================================
// Cross-process supervisor failover tests
// ============================================================
// Two supervisors share one MemoryRuntimeOrchestrationStore. Supervisor A
// "crashes" by stopping heartbeats; supervisor B sweeps for stale workers,
// evicts A's worker entry, and is then able to take over A's agent.

import { describe, expect, it, vi } from 'vitest';
import {
  MemoryRuntimeOrchestrationStore,
  RuntimeOrchestrator,
} from '../orchestration.js';
import { ManagedRuntimeSupervisor } from '../supervisor.js';

interface FakeMount {
  agentId: string;
  disposed: boolean;
}

function buildPair() {
  const clock = { value: 1000 };
  const store = new MemoryRuntimeOrchestrationStore();
  const orchestrator = new RuntimeOrchestrator({
    store,
    now: () => clock.value,
  });
  return { orchestrator, store, clock };
}

function makeFactory() {
  return vi.fn((agentId: string) => {
    const mount: FakeMount = { agentId, disposed: false };
    return {
      build: mount,
      dispose: async () => { mount.disposed = true; },
    };
  });
}

describe('ManagedRuntimeSupervisor cross-process failover', () => {
  it('starts a worker, heartbeats, and evicts stale peers', async () => {
    const { orchestrator } = buildPair();

    const evictionsA: unknown[] = [];
    const supervisorA = new ManagedRuntimeSupervisor<FakeMount>({
      orchestrator,
      holderId: 'process-A',
      leaseTtlMs: 60_000,
      worker: { capacity: 4, heartbeatTtlMs: 5_000 },
      onWorkerEvicted: (event) => evictionsA.push(event),
    });
    const workerA = await supervisorA.startWorker();
    expect(workerA.state).toBe('active');
    expect(workerA.holderId).toBe('process-A');

    // No stale peers yet.
    const noop = await supervisorA.evictStaleWorkers();
    expect(noop.evicted).toEqual([]);
    expect(evictionsA).toHaveLength(0);

    await supervisorA.stopWorker();
  });

  it('takes over an agent after the previous worker is evicted', async () => {
    const { orchestrator, clock } = buildPair();

    const supervisorA = new ManagedRuntimeSupervisor<FakeMount>({
      orchestrator,
      holderId: 'process-A',
      leaseTtlMs: 60_000,
      worker: { capacity: 4, heartbeatTtlMs: 5_000 },
    });
    await supervisorA.startWorker();
    const factoryA = makeFactory();
    const startResult = await supervisorA.start({
      agentId: 'agent-1',
      entry: 'entry-1',
      factory: factoryA,
    });
    expect(startResult.started).toBe(true);

    // Supervisor B starts on the shared store.
    const supervisorB = new ManagedRuntimeSupervisor<FakeMount>({
      orchestrator,
      holderId: 'process-B',
      leaseTtlMs: 60_000,
      worker: { capacity: 4, heartbeatTtlMs: 5_000 },
    });
    const workerB = await supervisorB.startWorker();
    expect(workerB.holderId).toBe('process-B');

    // While A is alive, B cannot take over the agent.
    const blocked = await supervisorB.start({
      agentId: 'agent-1',
      entry: 'entry-1',
      factory: makeFactory(),
    });
    expect(blocked.started).toBe(false);

    // Simulate process A dying: stop sending heartbeats, advance clock past TTL.
    // Supervisor B refreshes its own heartbeat right before sweeping so only
    // A's worker is evicted (real systems run a heartbeat timer concurrently).
    clock.value += 10_000;
    await orchestrator.heartbeatWorker(workerB.workerId, 5_000);
    const eviction = await supervisorB.evictStaleWorkers();
    expect(eviction.evicted).toHaveLength(1);
    expect(eviction.evicted[0].workerId).toBe(supervisorA.worker()!.workerId);
    expect(eviction.releasedLeases).toHaveLength(1);

    // Now supervisor B can mount the orphaned agent.
    const factoryB = makeFactory();
    const taken = await supervisorB.start({
      agentId: 'agent-1',
      entry: 'entry-1',
      factory: factoryB,
    });
    expect(taken.started).toBe(true);
    expect(factoryB).toHaveBeenCalledOnce();

    await supervisorB.stop('agent-1');
    await supervisorB.stopWorker();
  });

  it('enforces worker capacity for new mounts', async () => {
    const { orchestrator } = buildPair();
    const supervisor = new ManagedRuntimeSupervisor<FakeMount>({
      orchestrator,
      holderId: 'process-A',
      leaseTtlMs: 60_000,
      worker: { capacity: 1, heartbeatTtlMs: 5_000 },
    });
    await supervisor.startWorker();

    const first = await supervisor.start({
      agentId: 'agent-1',
      entry: '1',
      factory: makeFactory(),
    });
    expect(first.started).toBe(true);

    await expect(supervisor.start({
      agentId: 'agent-2',
      entry: '2',
      factory: makeFactory(),
    })).rejects.toThrow(/capacity/);

    await supervisor.stop('agent-1');
    await supervisor.stopWorker();
  });

  it('withdraws cleanly and releases its leases on stopWorker', async () => {
    const { orchestrator } = buildPair();
    const supervisor = new ManagedRuntimeSupervisor<FakeMount>({
      orchestrator,
      holderId: 'process-A',
      leaseTtlMs: 60_000,
      worker: { capacity: 2, heartbeatTtlMs: 5_000 },
    });
    await supervisor.startWorker();
    await supervisor.start({
      agentId: 'agent-1',
      entry: '1',
      factory: makeFactory(),
    });

    await supervisor.stopWorker();

    const workers = await orchestrator.listWorkers();
    expect(workers[0].state).toBe('withdrawn');
  });

  it('continues to work without worker registration (single-process mode)', async () => {
    const { orchestrator } = buildPair();
    const supervisor = new ManagedRuntimeSupervisor<FakeMount>({
      orchestrator,
      holderId: 'solo',
      leaseTtlMs: 60_000,
    });
    const result = await supervisor.start({
      agentId: 'agent-x',
      entry: 'x',
      factory: makeFactory(),
    });
    expect(result.started).toBe(true);
    const workers = await orchestrator.listWorkers();
    expect(workers).toEqual([]);
  });
});
