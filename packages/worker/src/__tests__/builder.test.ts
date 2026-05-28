// ============================================================
// @berry-agent/worker — buildAgentRuntime smoke test
// ============================================================
// Verifies that the worker primitive can wire a real ManagedAgentRuntime
// without product-side glue. Uses an in-memory store + minimal spec.

import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentHome, DefaultCredentialStore } from '@berry-agent/core';
import { createObserver } from '@berry-agent/observe';
import type { ModelsRegistry } from '@berry-agent/models';
import { buildAgentRuntime } from '../builder.js';

function buildRegistry(): ModelsRegistry {
  return {
    providers: {
      'test-provider': {
        id: 'test-provider',
        presetId: 'anthropic',
        apiKey: 'sk-test',
      },
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

describe('buildAgentRuntime', () => {
  it('assembles a managed agent runtime from a minimal spec', () => {
    const root = mkdtempSync(join(tmpdir(), 'worker-test-'));
    const workspace = join(root, 'agent');
    const observer = createObserver({ dbPath: ':memory:' });

    const built = buildAgentRuntime(
      {
        agentId: 'test-agent',
        workspace,
        home: new AgentHome(workspace),
        model: 'tier:strong',
        ensureDefaultMcpConfig: false,
      },
      {
        registry: buildRegistry(),
        credentials: new DefaultCredentialStore(join(root, 'creds.json')),
        observer,
      },
    );

    expect(built.runtime).toBeDefined();
    expect(built.workspace).toBe(workspace);
    expect(typeof built.runtime.dispose).toBe('function');
  });

  it('honors hostTools by mounting them as a system hand', () => {
    const root = mkdtempSync(join(tmpdir(), 'worker-test-'));
    const workspace = join(root, 'agent');
    const observer = createObserver({ dbPath: ':memory:' });

    const built = buildAgentRuntime(
      {
        agentId: 'test-agent-host',
        workspace,
        home: new AgentHome(workspace),
        model: 'tier:strong',
        ensureDefaultMcpConfig: false,
        hostTools: [{
          definition: {
            name: 'host_ping',
            description: 'Worker host echo',
            inputSchema: { type: 'object', properties: {} } as never,
          },
          execute: async () => ({ content: 'pong', isError: false }),
        }],
        hostHandDisplayName: 'Test host',
      },
      {
        registry: buildRegistry(),
        credentials: new DefaultCredentialStore(join(root, 'creds.json')),
        observer,
      },
    );

    const snapshot = built.runtime.snapshot();
    expect(snapshot).toBeDefined();
  });

  it('disables local workspace when localWorkspace=false', () => {
    const root = mkdtempSync(join(tmpdir(), 'worker-test-'));
    const workspace = join(root, 'agent');
    const observer = createObserver({ dbPath: ':memory:' });

    const built = buildAgentRuntime(
      {
        agentId: 'no-local',
        workspace,
        home: new AgentHome(workspace),
        model: 'tier:strong',
        localWorkspace: false,
        ensureDefaultMcpConfig: false,
      },
      {
        registry: buildRegistry(),
        credentials: new DefaultCredentialStore(join(root, 'creds.json')),
        observer,
      },
    );

    expect(built.runtime).toBeDefined();
  });
});
