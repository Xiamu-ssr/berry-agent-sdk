import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  FileRuntimeOrchestrationStore,
  MemoryRuntimeOrchestrationStore,
  RUNTIME_ORCHESTRATION_FILENAME,
  RuntimeOrchestrator,
  createFileRuntimeOrchestrationStore,
  parseRuntimeOrchestrationSnapshot,
  runtimeOrchestrationPath,
} from '../orchestration.js';

const tempDirs: string[] = [];

function clock(start = 1_000) {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => { now += ms; },
    set: (value: number) => { now = value; },
  };
}

function ids() {
  let n = 0;
  return (prefix: 'lease' | 'wake') => `${prefix}_${++n}`;
}

async function makeFileStore() {
  const dir = await mkdtemp(join(tmpdir(), 'berry-runtime-orchestration-'));
  tempDirs.push(dir);
  return {
    filePath: join(dir, 'orchestration.json'),
    store: new FileRuntimeOrchestrationStore(join(dir, 'orchestration.json')),
  };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('RuntimeOrchestrator leases', () => {
  it('acquires one active lease per agent and releases it', async () => {
    const time = clock();
    const orchestrator = new RuntimeOrchestrator({
      store: new MemoryRuntimeOrchestrationStore(),
      now: time.now,
      idFactory: ids(),
    });

    const first = await orchestrator.acquireLease({
      agentId: 'agent_1',
      holderId: 'worker_a',
      sessionId: 'session_1',
      ttlMs: 500,
    });
    expect(first).toEqual({
      acquired: true,
      lease: expect.objectContaining({
        leaseId: 'lease_1',
        agentId: 'agent_1',
        holderId: 'worker_a',
        state: 'active',
        acquiredAt: 1_000,
        expiresAt: 1_500,
      }),
    });

    const second = await orchestrator.acquireLease({
      agentId: 'agent_1',
      holderId: 'worker_b',
      ttlMs: 500,
    });
    expect(second).toEqual({
      acquired: false,
      active: expect.objectContaining({ leaseId: 'lease_1' }),
    });

    await orchestrator.releaseLease('lease_1');
    const third = await orchestrator.acquireLease({
      agentId: 'agent_1',
      holderId: 'worker_b',
      ttlMs: 500,
    });
    expect(third).toEqual({
      acquired: true,
      lease: expect.objectContaining({ leaseId: 'lease_2', holderId: 'worker_b' }),
    });
  });

  it('expires stale leases before acquiring a new one', async () => {
    const time = clock();
    const orchestrator = new RuntimeOrchestrator({
      store: new MemoryRuntimeOrchestrationStore(),
      now: time.now,
      idFactory: ids(),
    });

    await orchestrator.acquireLease({ agentId: 'agent_1', holderId: 'worker_a', ttlMs: 100 });
    time.advance(101);

    const next = await orchestrator.acquireLease({ agentId: 'agent_1', holderId: 'worker_b', ttlMs: 100 });

    expect(next).toEqual({
      acquired: true,
      lease: expect.objectContaining({ leaseId: 'lease_2', holderId: 'worker_b' }),
    });
    await expect(orchestrator.listLeases()).resolves.toEqual([
      expect.objectContaining({ leaseId: 'lease_1', state: 'expired', expiredAt: 1_101 }),
      expect.objectContaining({ leaseId: 'lease_2', state: 'active' }),
    ]);
  });

  it('renews only active leases', async () => {
    const time = clock();
    const orchestrator = new RuntimeOrchestrator({
      store: new MemoryRuntimeOrchestrationStore(),
      now: time.now,
      idFactory: ids(),
    });

    await orchestrator.acquireLease({ agentId: 'agent_1', holderId: 'worker_a', ttlMs: 100 });
    time.advance(50);

    await expect(orchestrator.renewLease('lease_1', 300)).resolves.toEqual(
      expect.objectContaining({ leaseId: 'lease_1', renewedAt: 1_050, expiresAt: 1_350 }),
    );

    time.set(1_351);
    await expect(orchestrator.renewLease('lease_1', 300)).resolves.toBeNull();
    await expect(orchestrator.getActiveLease('agent_1')).resolves.toBeNull();
  });

  it('renewAgentLease extends only the holder\'s active lease', async () => {
    const time = clock();
    const orchestrator = new RuntimeOrchestrator({
      store: new MemoryRuntimeOrchestrationStore(),
      now: time.now,
      idFactory: ids(),
    });

    await orchestrator.acquireLease({ agentId: 'agent_1', holderId: 'worker_a', ttlMs: 100 });
    time.advance(50);

    // The holder renews → expiry extended (keeps "brain alive ⇒ lease alive").
    const renewed = await orchestrator.renewAgentLease('agent_1', 'worker_a', 300);
    expect(renewed).toEqual(expect.objectContaining({ agentId: 'agent_1', renewedAt: 1_050, expiresAt: 1_350 }));

    // A non-holder cannot renew (no failover hijack via heartbeat).
    await expect(orchestrator.renewAgentLease('agent_1', 'worker_b', 300)).resolves.toBeNull();
    // The holder's lease is untouched by the failed non-holder attempt.
    await expect(orchestrator.getActiveLease('agent_1')).resolves.toEqual(
      expect.objectContaining({ holderId: 'worker_a', expiresAt: 1_350 }),
    );

    // Once expired, renewal does NOT resurrect — that path is acquire-by-new-holder.
    time.set(1_351);
    await expect(orchestrator.renewAgentLease('agent_1', 'worker_a', 300)).resolves.toBeNull();
    await expect(orchestrator.getActiveLease('agent_1')).resolves.toBeNull();
  });
});

describe('RuntimeOrchestrator wakes', () => {
  it('schedules, claims, and cancels wakes durably', async () => {
    const time = clock();
    const orchestrator = new RuntimeOrchestrator({
      store: new MemoryRuntimeOrchestrationStore(),
      now: time.now,
      idFactory: ids(),
    });

    const wakeA = await orchestrator.scheduleWake({
      agentId: 'agent_1',
      sessionId: 'session_1',
      dueAt: 1_050,
      reason: 'sleep_finished',
      payload: { source: 'test' },
    });
    const wakeB = await orchestrator.scheduleWake({
      agentId: 'agent_2',
      dueAt: 1_100,
      reason: 'poll',
    });

    await orchestrator.cancelWake(wakeB.wakeId);
    time.set(1_200);

    await expect(orchestrator.claimDueWakes()).resolves.toEqual([
      expect.objectContaining({
        wakeId: wakeA.wakeId,
        agentId: 'agent_1',
        state: 'claimed',
        claimedAt: 1_200,
      }),
    ]);
    await expect(orchestrator.claimDueWakes()).resolves.toEqual([]);
  });

  it('claims due wakes in dueAt order with a limit', async () => {
    const time = clock();
    const orchestrator = new RuntimeOrchestrator({
      store: new MemoryRuntimeOrchestrationStore(),
      now: time.now,
      idFactory: ids(),
    });

    await orchestrator.scheduleWake({ agentId: 'late', dueAt: 1_200, reason: 'late' });
    await orchestrator.scheduleWake({ agentId: 'early', dueAt: 1_100, reason: 'early' });
    time.set(1_300);

    await expect(orchestrator.claimDueWakes({ limit: 1 })).resolves.toEqual([
      expect.objectContaining({ agentId: 'early' }),
    ]);
    await expect(orchestrator.claimDueWakes()).resolves.toEqual([
      expect.objectContaining({ agentId: 'late' }),
    ]);
  });

  it('marks claimed wakes as completed or failed', async () => {
    const time = clock();
    const orchestrator = new RuntimeOrchestrator({
      store: new MemoryRuntimeOrchestrationStore(),
      now: time.now,
      idFactory: ids(),
    });

    await orchestrator.scheduleWake({ agentId: 'ok', dueAt: 1_000, reason: 'resume' });
    await orchestrator.scheduleWake({ agentId: 'bad', dueAt: 1_000, reason: 'resume' });
    const [ok, bad] = await orchestrator.claimDueWakes();
    if (!ok || !bad) throw new Error('expected claimed wakes');
    time.advance(10);

    await expect(orchestrator.completeWake(ok.wakeId)).resolves.toEqual(
      expect.objectContaining({ wakeId: ok.wakeId, state: 'completed', completedAt: 1_010 }),
    );
    await expect(orchestrator.failWake(bad.wakeId, 'boom')).resolves.toEqual(
      expect.objectContaining({ wakeId: bad.wakeId, state: 'failed', failedAt: 1_010, errorMessage: 'boom' }),
    );
    await expect(orchestrator.completeWake(ok.wakeId)).resolves.toBeNull();
  });

  it('requeues stale claimed wakes for crash recovery when requested', async () => {
    const time = clock();
    const orchestrator = new RuntimeOrchestrator({
      store: new MemoryRuntimeOrchestrationStore(),
      now: time.now,
      idFactory: ids(),
    });

    await orchestrator.scheduleWake({ agentId: 'agent_1', dueAt: 1_000, reason: 'resume' });
    await expect(orchestrator.claimDueWakes()).resolves.toEqual([
      expect.objectContaining({ wakeId: 'wake_1', state: 'claimed', claimAttempts: 1 }),
    ]);
    time.advance(99);
    await expect(orchestrator.claimDueWakes({ staleClaimedMs: 100 })).resolves.toEqual([]);

    time.advance(1);
    await expect(orchestrator.claimDueWakes({ staleClaimedMs: 100 })).resolves.toEqual([
      expect.objectContaining({ wakeId: 'wake_1', state: 'claimed', claimAttempts: 2, claimedAt: 1_100 }),
    ]);
  });
});

describe('RuntimeOrchestrationStore', () => {
  it('derives the SDK-owned orchestration file path from a host root', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'berry-runtime-root-'));
    tempDirs.push(dir);

    expect(runtimeOrchestrationPath(dir)).toBe(join(dir, RUNTIME_ORCHESTRATION_FILENAME));
    expect(createFileRuntimeOrchestrationStore(dir)).toBeInstanceOf(FileRuntimeOrchestrationStore);
  });

  it('persists leases and wakes to a strict JSON file', async () => {
    const time = clock();
    const { filePath, store } = await makeFileStore();
    const orchestrator = new RuntimeOrchestrator({
      store,
      now: time.now,
      idFactory: ids(),
    });

    await orchestrator.acquireLease({ agentId: 'agent_1', holderId: 'worker_a', ttlMs: 500 });
    await orchestrator.scheduleWake({ agentId: 'agent_1', dueAt: 2_000, reason: 'resume' });

    const saved = JSON.parse(await readFile(filePath, 'utf-8'));
    expect(saved.leases).toHaveLength(1);
    expect(saved.wakes).toHaveLength(1);

    const reloaded = new RuntimeOrchestrator({ store: new FileRuntimeOrchestrationStore(filePath), now: time.now });
    await expect(reloaded.getActiveLease('agent_1')).resolves.toEqual(
      expect.objectContaining({ agentId: 'agent_1', holderId: 'worker_a' }),
    );
  });

  it('rejects malformed persisted orchestration snapshots', async () => {
    await expect(() => parseRuntimeOrchestrationSnapshot('[]')).toThrow(/expected object/);
    await expect(() => parseRuntimeOrchestrationSnapshot('{"leases":[{"leaseId":""}]}')).toThrow(/expected non-empty string/);

    const { filePath, store } = await makeFileStore();
    await writeFile(filePath, '{"leases":[],"wakes":[{"wakeId":"w1","agentId":"a","reason":"r","state":"pending","createdAt":1,"dueAt":"soon"}]}', 'utf-8');

    await expect(store.load()).rejects.toThrow(/expected finite number/);
  });
});
