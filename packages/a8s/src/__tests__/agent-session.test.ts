// ============================================================
// @berry-agent/a8s — AgentSession + openAgent + hydrateAssignments
// ============================================================
// Verifies the data-plane handle returned by ControlPlane.openAgent:
//   - InProcessAgentSession transparently delegates to ManagedAgentRuntime
//   - openAgent surfaces the right errors when the agent / worker is missing
//   - hydrateAssignments rebuilds the in-memory map from durable leases
//
// Uses real Worker + buildAgentRuntime so transport-shape regressions show
// up here instead of in product code.

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
import {
  ControlPlane,
  InProcessAgentSession,
  InProcessWorkerNode,
} from '../index.js';

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

describe('ControlPlane.openAgent', () => {
  it('returns an AgentSession that delegates data-plane reads to the runtime', async () => {
    const root = mkdtempSync(join(tmpdir(), 'a8s-session-'));
    const orchestrator = new RuntimeOrchestrator({
      store: new MemoryRuntimeOrchestrationStore(),
    });
    const worker = new Worker<TestEntry>({ env: makeEnv(root) });
    const plane = new ControlPlane<TestEntry>({ orchestrator });
    plane.addWorker(new InProcessWorkerNode('w1', worker));

    await plane.createAgent(makeSpec('a1', root), { tag: 'one' });
    const session = await plane.openAgent('a1');

    expect(session).toBeInstanceOf(InProcessAgentSession);
    expect(session.agentId).toBe('a1');

    const snapshot = await session.snapshot();
    expect(snapshot.provider.type).toBe('anthropic');
    expect(snapshot.cwd).toContain('a1');
    const status = await session.getStatus();
    expect(['idle', 'running', 'paused']).toContain(status.status);
    const provider = await session.currentProvider();
    expect(provider.type).toBe('anthropic');
    expect(provider.apiKeyConfigured).toBe(true);

    const view = await session.createSession();
    expect(typeof view.id).toBe('string');
    expect(view.id.length).toBeGreaterThan(0);
    const list = await session.listSessionViews();
    expect(list.length).toBeGreaterThanOrEqual(1);
    const activeId = await session.getActiveSessionId();
    expect(activeId).toBeDefined();

    await plane.deleteAgent('a1');
    await worker.dispose();
  });

  it('throws when the agent is unknown to the plane', async () => {
    const orchestrator = new RuntimeOrchestrator({
      store: new MemoryRuntimeOrchestrationStore(),
    });
    const plane = new ControlPlane<TestEntry>({ orchestrator });
    await expect(plane.openAgent('missing')).rejects.toThrow(/not assigned/);
  });

  it('throws when the owning worker has been removed', async () => {
    const root = mkdtempSync(join(tmpdir(), 'a8s-session-'));
    const orchestrator = new RuntimeOrchestrator({
      store: new MemoryRuntimeOrchestrationStore(),
    });
    const worker = new Worker<TestEntry>({ env: makeEnv(root) });
    const plane = new ControlPlane<TestEntry>({ orchestrator });
    plane.addWorker(new InProcessWorkerNode('w1', worker));
    await plane.createAgent(makeSpec('a1', root), { tag: '' });

    // Simulate a stale assignment: the worker is gone but plane.assignments
    // still points at it. removeWorker() also clears assignments, so we
    // delete the worker entry directly to reproduce the failure path.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (plane as any).workers.delete('w1');
    await expect(plane.openAgent('a1')).rejects.toThrow(/not registered/);

    await worker.dispose();
  });

  it('throws when the worker has no live mount for the agent', async () => {
    const root = mkdtempSync(join(tmpdir(), 'a8s-session-'));
    const orchestrator = new RuntimeOrchestrator({
      store: new MemoryRuntimeOrchestrationStore(),
    });
    const worker = new Worker<TestEntry>({ env: makeEnv(root) });
    const plane = new ControlPlane<TestEntry>({ orchestrator });
    plane.addWorker(new InProcessWorkerNode('w1', worker));
    await plane.createAgent(makeSpec('a1', root), { tag: '' });

    // Drop the live mount under the plane's feet (e.g. crash/forced unmount).
    await worker.stopAgent('a1');
    await expect(plane.openAgent('a1')).rejects.toThrow(/no live mount/);

    await worker.dispose();
  });
});

describe('ControlPlane.hydrateAssignments', () => {
  it('rebuilds assignments from active leases owned by registered workers', async () => {
    const orchestrator = new RuntimeOrchestrator({
      store: new MemoryRuntimeOrchestrationStore(),
    });
    // Register both workers + acquire leases *before* the plane wakes up —
    // mimicking a process restart where some workers reconnect and some
    // haven't yet.
    await orchestrator.registerWorker({
      workerId: 'w1',
      holderId: 'pre-restart',
      capacity: 8,
      heartbeatTtlMs: 60_000,
    });
    await orchestrator.registerWorker({
      workerId: 'w2-gone',
      holderId: 'pre-restart',
      capacity: 8,
      heartbeatTtlMs: 60_000,
    });
    await orchestrator.acquireLease({
      agentId: 'a1',
      holderId: 'pre-restart',
      workerId: 'w1',
      ttlMs: 60_000,
    });
    await orchestrator.acquireLease({
      agentId: 'a2',
      holderId: 'pre-restart',
      workerId: 'w2-gone',
      ttlMs: 60_000,
    });

    const root = mkdtempSync(join(tmpdir(), 'a8s-session-'));
    const worker = new Worker<TestEntry>({ env: makeEnv(root) });
    const plane = new ControlPlane<TestEntry>({ orchestrator });
    plane.addWorker(new InProcessWorkerNode('w1', worker));

    const result = await plane.hydrateAssignments();
    expect(result.restored).toEqual([{ agentId: 'a1', workerId: 'w1' }]);
    expect(result.unowned).toEqual([{ agentId: 'a2', workerId: 'w2-gone' }]);
    expect(plane.getAgentLocation('a1').workerId).toBe('w1');
    expect(plane.getAgentLocation('a2').workerId).toBeNull();

    await worker.dispose();
  });

  it('returns empty arrays when there are no active leases', async () => {
    const orchestrator = new RuntimeOrchestrator({
      store: new MemoryRuntimeOrchestrationStore(),
    });
    const plane = new ControlPlane<TestEntry>({ orchestrator });
    const result = await plane.hydrateAssignments();
    expect(result.restored).toEqual([]);
    expect(result.unowned).toEqual([]);
  });
});
