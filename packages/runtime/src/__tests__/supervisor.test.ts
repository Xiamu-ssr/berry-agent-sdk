import { describe, expect, it, vi } from 'vitest';
import type { ManagedAgentRuntime } from '@berry-agent/core';
import { MemoryRuntimeOrchestrationStore, RuntimeOrchestrator } from '../orchestration.js';
import { ManagedRuntimeSupervisor } from '../supervisor.js';

function runtime(id: string) {
  const dispose = vi.fn();
  return {
    runtime: { dispose } as unknown as ManagedAgentRuntime,
    workspace: `/tmp/${id}`,
    dispose,
  };
}

function clock(start = 1_000) {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => { now += ms; },
  };
}

function ids() {
  let n = 0;
  return (prefix: 'lease' | 'wake') => `${prefix}_${++n}`;
}

function orchestrator(time = clock()) {
  return {
    time,
    orchestrator: new RuntimeOrchestrator({
      store: new MemoryRuntimeOrchestrationStore(),
      now: time.now,
      idFactory: ids(),
    }),
  };
}

describe('ManagedRuntimeSupervisor', () => {
  it('starts exactly one leased runtime per agent and releases it after teardown', async () => {
    const { orchestrator: runtimeOrchestrator } = orchestrator();
    const first = new ManagedRuntimeSupervisor<{ model: string }, ReturnType<typeof runtime>>({
      orchestrator: runtimeOrchestrator,
      holderId: 'worker-a',
      leaseTtlMs: 500,
    });
    const second = new ManagedRuntimeSupervisor<{ model: string }, ReturnType<typeof runtime>>({
      orchestrator: runtimeOrchestrator,
      holderId: 'worker-b',
      leaseTtlMs: 500,
    });

    const started = await first.start({
      agentId: 'agent_1',
      entry: { model: 'fast' },
      factory: (id) => runtime(id),
    });
    expect(started).toEqual({
      started: true,
      reused: false,
      lease: expect.objectContaining({ leaseId: 'lease_1', holderId: 'worker-a' }),
      mount: expect.objectContaining({ id: 'agent_1' }),
    });

    const denied = await second.start({
      agentId: 'agent_1',
      entry: { model: 'fast' },
      factory: (id) => runtime(id),
    });
    expect(denied).toEqual({
      started: false,
      activeLease: expect.objectContaining({ leaseId: 'lease_1', holderId: 'worker-a' }),
    });

    if (!started.started) throw new Error('expected runtime to start');
    await first.stop('agent_1');
    expect(started.mount.dispose).toHaveBeenCalledTimes(1);

    const restarted = await second.start({
      agentId: 'agent_1',
      entry: { model: 'strong' },
      factory: (id) => runtime(id),
    });
    expect(restarted).toEqual({
      started: true,
      reused: false,
      lease: expect.objectContaining({ leaseId: 'lease_2', holderId: 'worker-b' }),
      mount: expect.objectContaining({ id: 'agent_1' }),
    });
  });

  it('reuses an already mounted runtime while its lease is active', async () => {
    const { orchestrator: runtimeOrchestrator } = orchestrator();
    const supervisor = new ManagedRuntimeSupervisor<{ model: string }, ReturnType<typeof runtime>>({
      orchestrator: runtimeOrchestrator,
      holderId: 'worker-a',
      leaseTtlMs: 500,
    });

    const first = await supervisor.start({
      agentId: 'agent_1',
      entry: { model: 'fast' },
      factory: (id) => runtime(id),
    });
    const second = await supervisor.start({
      agentId: 'agent_1',
      entry: { model: 'fast' },
      factory: () => {
        throw new Error('factory should not run');
      },
    });

    if (!first.started || !second.started) throw new Error('expected runtime reuse');
    expect(second.mount).toBe(first.mount);
    expect(second).toEqual({
      started: true,
      reused: true,
      lease: expect.objectContaining({ leaseId: 'lease_1' }),
      mount: expect.objectContaining({ id: 'agent_1' }),
    });
  });

  it('releases a lease when runtime construction fails', async () => {
    const { orchestrator: runtimeOrchestrator } = orchestrator();
    const supervisor = new ManagedRuntimeSupervisor<{ model: string }>({
      orchestrator: runtimeOrchestrator,
      holderId: 'worker-a',
      leaseTtlMs: 500,
    });

    await expect(supervisor.start({
      agentId: 'agent_1',
      entry: { model: 'fast' },
      factory: () => {
        throw new Error('boom');
      },
    })).rejects.toThrow(/boom/);

    await expect(runtimeOrchestrator.getActiveLease('agent_1')).resolves.toBeNull();
  });

  it('renews active leases and stops runtimes when a lease is lost', async () => {
    const time = clock();
    const { orchestrator: runtimeOrchestrator } = orchestrator(time);
    const onLeaseLost = vi.fn();
    const supervisor = new ManagedRuntimeSupervisor<{ model: string }, ReturnType<typeof runtime>>({
      orchestrator: runtimeOrchestrator,
      holderId: 'worker-a',
      leaseTtlMs: 100,
      onLeaseLost,
    });

    const started = await supervisor.start({
      agentId: 'agent_1',
      entry: { model: 'fast' },
      factory: (id) => runtime(id),
    });
    if (!started.started) throw new Error('expected runtime to start');

    time.advance(50);
    await expect(supervisor.renew('agent_1')).resolves.toEqual(
      expect.objectContaining({ leaseId: 'lease_1', renewedAt: 1_050, expiresAt: 1_150 }),
    );

    time.advance(101);
    await expect(supervisor.renew('agent_1')).resolves.toBeNull();
    expect(started.mount.dispose).toHaveBeenCalledTimes(1);
    expect(supervisor.get('agent_1')).toBeUndefined();
    expect(onLeaseLost).toHaveBeenCalledWith('agent_1', 'lease_1');
  });

  it('keeps wake scheduling behind the same runtime supervision boundary', async () => {
    const time = clock();
    const { orchestrator: runtimeOrchestrator } = orchestrator(time);
    const supervisor = new ManagedRuntimeSupervisor<never>({
      orchestrator: runtimeOrchestrator,
      holderId: 'worker-a',
      leaseTtlMs: 100,
    });

    await supervisor.scheduleWake({ agentId: 'agent_1', dueAt: 1_100, reason: 'resume' });
    await expect(supervisor.listPendingWakes()).resolves.toEqual([
      expect.objectContaining({ agentId: 'agent_1', state: 'pending' }),
    ]);

    time.advance(101);
    await expect(supervisor.claimDueWakes()).resolves.toEqual([
      expect.objectContaining({ agentId: 'agent_1', state: 'claimed' }),
    ]);
  });
});
