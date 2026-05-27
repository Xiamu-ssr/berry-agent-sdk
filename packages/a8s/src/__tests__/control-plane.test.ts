// ============================================================
// @berry-agent/a8s — ControlPlane integration tests
// ============================================================
// Spin up two in-process Workers, register them with a ControlPlane,
// create agents through the cluster API. No mocks for the SDK layer —
// real WorkerAgentSpec -> real buildAgentRuntime -> real Worker mounts.

import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentHome, DefaultCredentialStore } from '@berry-agent/core';
import { createObserver } from '@berry-agent/observe';
import type { ModelsRegistry } from '@berry-agent/models';
import {
  MemoryRuntimeOrchestrationStore,
  RuntimeOrchestrator,
} from '@berry-agent/runtime';
import { Worker, type WorkerAgentSpec, type WorkerEnvironment } from '@berry-agent/worker';
import { ControlPlane, InProcessWorkerNode, createRoundRobinScheduler } from '../index.js';

function buildRegistry(): ModelsRegistry {
  return {
    providers: {
      'test-provider': { id: 'test-provider', presetId: 'anthropic', apiKey: 'sk-test' },
    },
    models: {
      'claude-sonnet-4-5': {
        id: 'claude-sonnet-4-5',
        contextWindow: 200_000,
        providers: [{ providerId: 'test-provider' }],
      },
    },
    tiers: { strong: 'claude-sonnet-4-5' },
  } as ModelsRegistry;
}

function makeEnv(root: string): WorkerEnvironment {
  return {
    registry: buildRegistry(),
    credentials: new DefaultCredentialStore(join(root, 'creds.json')),
    observer: createObserver({ dbPath: ':memory:' }),
  };
}

function makeSpec(agentId: string, root: string): WorkerAgentSpec {
  const workspace = join(root, agentId);
  return {
    agentId,
    workspace,
    home: new AgentHome(workspace),
    model: 'tier:strong',
    ensureDefaultMcpConfig: false,
  };
}

interface TestEntry { tag: string }

describe('ControlPlane', () => {
  it('schedules an agent on the only registered worker', async () => {
    const root = mkdtempSync(join(tmpdir(), 'a8s-test-'));
    const orchestrator = new RuntimeOrchestrator({
      store: new MemoryRuntimeOrchestrationStore(),
    });
    const worker = new Worker<TestEntry>({ env: makeEnv(root) });
    const plane = new ControlPlane<TestEntry>({ orchestrator });
    plane.addWorker(new InProcessWorkerNode('w1', worker));

    const result = await plane.createAgent(makeSpec('a1', root), { tag: 'one' });
    expect(result).toEqual({ agentId: 'a1', workerId: 'w1' });
    expect(plane.getAgentLocation('a1').workerId).toBe('w1');
    expect(worker.has('a1')).toBe(true);

    await plane.deleteAgent('a1');
    expect(plane.getAgentLocation('a1').workerId).toBeNull();
    expect(worker.has('a1')).toBe(false);

    await worker.dispose();
  });

  it('distributes agents across two workers via round-robin', async () => {
    const root = mkdtempSync(join(tmpdir(), 'a8s-test-'));
    const orchestrator = new RuntimeOrchestrator({
      store: new MemoryRuntimeOrchestrationStore(),
    });
    const w1 = new Worker<TestEntry>({ env: makeEnv(root) });
    const w2 = new Worker<TestEntry>({ env: makeEnv(root) });
    const plane = new ControlPlane<TestEntry>({
      orchestrator,
      scheduler: createRoundRobinScheduler<TestEntry>(),
    });
    plane.addWorker(new InProcessWorkerNode('w1', w1));
    plane.addWorker(new InProcessWorkerNode('w2', w2));

    const a = await plane.createAgent(makeSpec('a1', root), { tag: 'a' });
    const b = await plane.createAgent(makeSpec('a2', root), { tag: 'b' });
    const c = await plane.createAgent(makeSpec('a3', root), { tag: 'c' });

    // Round-robin: a1→w1, a2→w2, a3→w1
    expect([a.workerId, b.workerId, c.workerId]).toEqual(['w1', 'w2', 'w1']);

    await w1.dispose();
    await w2.dispose();
  });

  it('refuses to create an agent already running on a worker', async () => {
    const root = mkdtempSync(join(tmpdir(), 'a8s-test-'));
    const orchestrator = new RuntimeOrchestrator({
      store: new MemoryRuntimeOrchestrationStore(),
    });
    const w1 = new Worker<TestEntry>({ env: makeEnv(root) });
    const plane = new ControlPlane<TestEntry>({ orchestrator });
    plane.addWorker(new InProcessWorkerNode('w1', w1));

    await plane.createAgent(makeSpec('a1', root), { tag: 'x' });
    await expect(
      plane.createAgent(makeSpec('a1', root), { tag: 'y' }),
    ).rejects.toThrow(/already running/);

    await w1.dispose();
  });

  it('migrateAgent stops on the old worker and starts on the new one', async () => {
    const root = mkdtempSync(join(tmpdir(), 'a8s-test-'));
    const orchestrator = new RuntimeOrchestrator({
      store: new MemoryRuntimeOrchestrationStore(),
    });
    const w1 = new Worker<TestEntry>({ env: makeEnv(root) });
    const w2 = new Worker<TestEntry>({ env: makeEnv(root) });
    const plane = new ControlPlane<TestEntry>({
      orchestrator,
      scheduler: createRoundRobinScheduler<TestEntry>(),
    });
    plane.addWorker(new InProcessWorkerNode('w1', w1));
    plane.addWorker(new InProcessWorkerNode('w2', w2));

    await plane.createAgent(makeSpec('shared', root), { tag: '1' });
    expect(plane.getAgentLocation('shared').workerId).toBe('w1');
    expect(w1.has('shared')).toBe(true);

    await plane.migrateAgent('shared', makeSpec('shared', root), { tag: '2' });
    expect(w1.has('shared')).toBe(false);
    // After migration, round-robin moves to the next worker
    expect(plane.getAgentLocation('shared').workerId).toBe('w2');
    expect(w2.has('shared')).toBe(true);

    await w1.dispose();
    await w2.dispose();
  });

  it('throws when no worker has capacity', async () => {
    const root = mkdtempSync(join(tmpdir(), 'a8s-test-'));
    const orchestrator = new RuntimeOrchestrator({
      store: new MemoryRuntimeOrchestrationStore(),
    });
    const plane = new ControlPlane<TestEntry>({ orchestrator });

    await expect(plane.createAgent(makeSpec('a1', root), { tag: 'x' }))
      .rejects.toThrow(/No workers registered/);
  });

  it('listAgents reports cluster-wide assignments', async () => {
    const root = mkdtempSync(join(tmpdir(), 'a8s-test-'));
    const orchestrator = new RuntimeOrchestrator({
      store: new MemoryRuntimeOrchestrationStore(),
    });
    const w1 = new Worker<TestEntry>({ env: makeEnv(root) });
    const w2 = new Worker<TestEntry>({ env: makeEnv(root) });
    const plane = new ControlPlane<TestEntry>({
      orchestrator,
      scheduler: createRoundRobinScheduler<TestEntry>(),
    });
    plane.addWorker(new InProcessWorkerNode('w1', w1));
    plane.addWorker(new InProcessWorkerNode('w2', w2));

    await plane.createAgent(makeSpec('a1', root), { tag: '' });
    await plane.createAgent(makeSpec('a2', root), { tag: '' });

    const list = plane.listAgents();
    expect(list).toHaveLength(2);
    const ids = list.map((l) => l.agentId).sort();
    expect(ids).toEqual(['a1', 'a2']);

    await w1.dispose();
    await w2.dispose();
  });

  it('scheduleWake delegates to the orchestrator', async () => {
    const orchestrator = new RuntimeOrchestrator({
      store: new MemoryRuntimeOrchestrationStore(),
    });
    const plane = new ControlPlane<TestEntry>({ orchestrator });

    const wake = await plane.scheduleWake({
      agentId: 'a1',
      dueAt: Date.now() + 60_000,
      reason: 'cron',
    });
    expect(wake.state).toBe('pending');
    expect(wake.reason).toBe('cron');

    const pending = await orchestrator.listPendingWakes();
    expect(pending).toHaveLength(1);
  });

  it('capacityReport aggregates worker views', async () => {
    const root = mkdtempSync(join(tmpdir(), 'a8s-test-'));
    const orchestrator = new RuntimeOrchestrator({
      store: new MemoryRuntimeOrchestrationStore(),
    });
    const w1 = new Worker<TestEntry>({ env: makeEnv(root) });
    const plane = new ControlPlane<TestEntry>({ orchestrator });
    plane.addWorker(new InProcessWorkerNode('w1', w1));

    const report = await plane.capacityReport();
    expect(report).toHaveLength(1);
    expect(report[0].workerId).toBe('w1');
    expect(report[0].capacity.used).toBe(0);

    await plane.createAgent(makeSpec('a1', root), { tag: '' });
    const report2 = await plane.capacityReport();
    expect(report2[0].capacity.used).toBe(1);

    await w1.dispose();
  });
});
