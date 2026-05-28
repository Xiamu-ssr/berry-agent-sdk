// ============================================================
// @berry-agent/worker — Worker class tests
// ============================================================

import { describe, expect, it } from 'vitest';
import {
  MemoryRuntimeOrchestrationStore,
  RuntimeOrchestrator,
} from '@berry-agent/runtime';
import { Worker, WorkerLeaseConflictError } from '../worker.js';
import { makeTestWorkerSetup } from '../test-utils.js';

interface TestEntry { tag: string }

describe('Worker', () => {
  it('runs an agent and stops it (single-process mode)', async () => {
    const { env, spec } = makeTestWorkerSetup('worker-class-test-');
    const worker = new Worker<TestEntry>({ env });

    const mount = await worker.runAgent('alice', { tag: 'a' }, spec('alice'));
    expect(mount.id).toBe('alice');
    expect(mount.entry.tag).toBe('a');
    expect(worker.has('alice')).toBe(true);
    expect(worker.ids()).toEqual(['alice']);

    await worker.stopAgent('alice');
    expect(worker.has('alice')).toBe(false);
    await worker.dispose();
  });

  it('updates entry without rebuilding runtime', async () => {
    const { env, spec } = makeTestWorkerSetup('worker-class-test-');
    const worker = new Worker<TestEntry>({ env });
    await worker.runAgent('bob', { tag: 'v1' }, spec('bob'));
    const firstRuntime = worker.runtime('bob');

    worker.updateEntry('bob', { tag: 'v2' });
    expect(worker.get('bob')?.entry.tag).toBe('v2');
    expect(worker.runtime('bob')).toBe(firstRuntime);

    await worker.dispose();
  });

  it('replaces runtime via replaceAgent', async () => {
    const { env, spec } = makeTestWorkerSetup('worker-class-test-');
    const worker = new Worker<TestEntry>({ env });
    await worker.runAgent('carol', { tag: '1' }, spec('carol'));
    const before = worker.runtime('carol');

    await worker.replaceAgent('carol', { tag: '2' }, spec('carol'));
    const after = worker.runtime('carol');
    expect(after).not.toBe(before);
    expect(worker.get('carol')?.entry.tag).toBe('2');

    await worker.dispose();
  });

  it('starts and stops a durable worker entry via supervisor', async () => {
    const { env } = makeTestWorkerSetup('worker-class-test-');
    const orchestrator = new RuntimeOrchestrator({
      store: new MemoryRuntimeOrchestrationStore(),
    });

    const worker = new Worker<TestEntry>({
      env,
      supervisor: {
        orchestrator,
        holderId: 'process-A',
        leaseTtlMs: 60_000,
        worker: { capacity: 4, heartbeatTtlMs: 10_000 },
        autoStart: false,
      },
    });

    const entry = await worker.startWorker();
    expect(entry.state).toBe('active');
    expect(entry.capacity).toBe(4);

    await worker.stopWorker();
    const after = await orchestrator.listWorkers();
    expect(after[0].state).toBe('withdrawn');

    await worker.dispose();
  });

  it('two workers fail over: A holds, B refused, A evicts, B takes over', async () => {
    const { env: envA, spec } = makeTestWorkerSetup('worker-class-test-');
    const { env: envB } = makeTestWorkerSetup('worker-class-test-');
    const store = new MemoryRuntimeOrchestrationStore();
    let now = 1000;
    const orchestrator = new RuntimeOrchestrator({ store, now: () => now });

    const workerA = new Worker<TestEntry>({
      env: envA,
      supervisor: {
        orchestrator,
        holderId: 'process-A',
        leaseTtlMs: 60_000,
        worker: { capacity: 4, heartbeatTtlMs: 5_000 },
      },
    });
    await workerA.runAgent('shared', { tag: 'a' }, spec('shared'));
    expect(workerA.has('shared')).toBe(true);

    const workerB = new Worker<TestEntry>({
      env: envB,
      supervisor: {
        orchestrator,
        holderId: 'process-B',
        leaseTtlMs: 60_000,
        worker: { capacity: 4, heartbeatTtlMs: 5_000 },
      },
    });
    await workerB.startWorker();

    // B refused while A is alive.
    await expect(workerB.runAgent('shared', { tag: 'b' }, spec('shared')))
      .rejects.toBeInstanceOf(WorkerLeaseConflictError);

    // Time passes past A's heartbeat TTL. B refreshes its own heartbeat
    // and sweeps stale workers; A's lease becomes available.
    now += 10_000;
    await orchestrator.heartbeatWorker(workerB.worker()!.workerId, 5_000);
    await workerB.evictStaleWorkers();

    const taken = await workerB.runAgent('shared', { tag: 'b' }, spec('shared'));
    expect(taken.entry.tag).toBe('b');

    await workerA.dispose();
    await workerB.dispose();
  });

  it('exposes orchestrator getter for hosts that need wake/capacity queries', async () => {
    const { env } = makeTestWorkerSetup('worker-class-test-');
    const orchestrator = new RuntimeOrchestrator({
      store: new MemoryRuntimeOrchestrationStore(),
    });

    const worker = new Worker<TestEntry>({
      env,
      supervisor: {
        orchestrator,
        holderId: 'process-X',
        leaseTtlMs: 60_000,
      },
    });

    expect(worker.orchestrator()).toBe(orchestrator);
    expect(worker.supervisor()).toBeNull();
  });

  it('worker() returns RuntimeWorker entry once supervisor mode is active', async () => {
    const { env } = makeTestWorkerSetup('worker-class-test-');
    const orchestrator = new RuntimeOrchestrator({
      store: new MemoryRuntimeOrchestrationStore(),
    });
    const worker = new Worker<TestEntry>({
      env,
      supervisor: {
        orchestrator,
        holderId: 'process-Y',
        leaseTtlMs: 60_000,
        worker: { capacity: 2, heartbeatTtlMs: 5_000 },
        autoStart: false,
      },
    });

    expect(worker.worker()).toBeNull();
    await worker.startWorker();
    expect(worker.worker()?.holderId).toBe('process-Y');
    expect(worker.supervisor()?.worker()?.holderId).toBe('process-Y');

    await worker.dispose();
  });
});
