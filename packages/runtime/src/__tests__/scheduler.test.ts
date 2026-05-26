import { describe, expect, it, vi } from 'vitest';
import { MemoryRuntimeOrchestrationStore, RuntimeOrchestrator } from '../orchestration.js';
import { ManagedRuntimeWakeScheduler } from '../scheduler.js';

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

describe('ManagedRuntimeWakeScheduler', () => {
  it('claims due wakes, handles them, and marks them completed', async () => {
    const time = clock();
    const { orchestrator: runtimeOrchestrator } = orchestrator(time);
    await runtimeOrchestrator.scheduleWake({ agentId: 'agent_1', dueAt: 1_000, reason: 'resume' });

    const onWake = vi.fn();
    const scheduler = new ManagedRuntimeWakeScheduler({
      orchestrator: runtimeOrchestrator,
      onWake,
    });

    await expect(scheduler.tick()).resolves.toEqual([
      expect.objectContaining({ wakeId: 'wake_1', state: 'completed' }),
    ]);
    expect(onWake).toHaveBeenCalledWith(expect.objectContaining({ wakeId: 'wake_1', state: 'claimed' }));
    await expect(runtimeOrchestrator.claimDueWakes()).resolves.toEqual([]);
  });

  it('marks handler failures as failed wake facts without stopping the batch', async () => {
    const time = clock();
    const { orchestrator: runtimeOrchestrator } = orchestrator(time);
    await runtimeOrchestrator.scheduleWake({ agentId: 'bad', dueAt: 1_000, reason: 'resume' });
    await runtimeOrchestrator.scheduleWake({ agentId: 'ok', dueAt: 1_000, reason: 'resume' });

    const onError = vi.fn();
    const scheduler = new ManagedRuntimeWakeScheduler({
      orchestrator: runtimeOrchestrator,
      onError,
      onWake: async (wake) => {
        if (wake.agentId === 'bad') throw new Error('boom');
      },
    });

    const handled = await scheduler.tick();

    expect(handled).toEqual([
      expect.objectContaining({ wakeId: 'wake_1', state: 'failed', errorMessage: 'boom' }),
      expect.objectContaining({ wakeId: 'wake_2', state: 'completed' }),
    ]);
    expect(onError).toHaveBeenCalledWith(expect.any(Error), expect.objectContaining({ wakeId: 'wake_1' }));
  });

  it('does not run overlapping ticks', async () => {
    const { orchestrator: runtimeOrchestrator } = orchestrator();
    await runtimeOrchestrator.scheduleWake({ agentId: 'agent_1', dueAt: 1_000, reason: 'resume' });
    let release: (() => void) | undefined;
    const wait = new Promise<void>((resolve) => { release = resolve; });
    const scheduler = new ManagedRuntimeWakeScheduler({
      orchestrator: runtimeOrchestrator,
      onWake: () => wait,
    });

    const first = scheduler.tick();
    await expect(scheduler.tick()).resolves.toEqual([]);
    release?.();
    await first;
  });

  it('can recover stale claimed wakes through the scheduler option', async () => {
    const time = clock();
    const { orchestrator: runtimeOrchestrator } = orchestrator(time);
    await runtimeOrchestrator.scheduleWake({ agentId: 'agent_1', dueAt: 1_000, reason: 'resume' });
    await runtimeOrchestrator.claimDueWakes();
    time.advance(100);

    const scheduler = new ManagedRuntimeWakeScheduler({
      orchestrator: runtimeOrchestrator,
      staleClaimedMs: 100,
      onWake: () => undefined,
    });

    await expect(scheduler.tick()).resolves.toEqual([
      expect.objectContaining({ wakeId: 'wake_1', state: 'completed', claimAttempts: 2 }),
    ]);
  });
});
