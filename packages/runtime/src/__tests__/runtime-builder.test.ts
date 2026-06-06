import { existsSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AgentHome,
  MemoryCredentialStore,
  createExecutionEnvironment,
  createToolRegistrationHand,
} from '@berry-agent/core';
import { DEFAULT_PLAYWRIGHT_MCP_TEMPLATE } from '@berry-agent/mcp';
import type { ModelsRegistry } from '@berry-agent/models';
import {
  buildEnvironmentContext,
  createEnvironmentSystemPrompt,
  createManagedRuntime,
  createManagedRuntimeAsync,
} from '../index.js';

const registry: ModelsRegistry = {
  providers: {
    test_openai: { id: 'test_openai', presetId: 'openai', apiKey: 'test-key' },
  },
  models: {
    'gpt-test': {
      id: 'gpt-test',
      providers: [{ providerId: 'test_openai' }],
    },
  },
  tiers: { fast: 'gpt-test' },
};

describe('createManagedRuntime', () => {
  it('builds a managed runtime without exposing raw Agent construction', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'berry-runtime-'));
    const built = createManagedRuntime({
      agentId: 'agent-a',
      workspace,
      home: new AgentHome(workspace),
      registry,
      credentials: new MemoryCredentialStore(),
      model: 'gpt-test',
      workspaceTools: false,
      webTools: false,
    });
    const runtime = built.runtime;

    expect(runtime.agentId).toBe('agent-a');
    expect(built.executionEnvironment).toBeUndefined();
    expect(runtime.getStatus().status).toBe('idle');
    expect(runtime.snapshot().tools.some((tool) => tool.name === 'shell')).toBe(false);
    await runtime.dispose();
  });

  it('can seed the SDK-owned agent MCP config through the runtime builder', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'berry-runtime-mcp-'));
    const home = new AgentHome(workspace);
    const runtime = createManagedRuntime({
      agentId: 'agent-mcp',
      workspace,
      home,
      registry,
      credentials: new MemoryCredentialStore(),
      model: 'gpt-test',
      workspaceTools: false,
      webTools: false,
      mcp: { ensureDefaultConfig: true },
    }).runtime;

    expect(existsSync(home.mcpConfigPath)).toBe(true);
    expect(JSON.parse(readFileSync(home.mcpConfigPath, 'utf-8'))).toEqual(DEFAULT_PLAYWRIGHT_MCP_TEMPLATE);
    await runtime.dispose();
  });

  it('mounts hands supplied by the execution environment', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'berry-runtime-env-'));
    const built = createManagedRuntime({
      agentId: 'agent-env',
      workspace,
      home: new AgentHome(workspace),
      registry,
      credentials: new MemoryCredentialStore(),
      model: 'gpt-test',
      workspaceTools: false,
      webTools: false,
      executionEnvironment: createExecutionEnvironment({
        id: 'remote-worker',
        kind: 'remote',
        createHands: () => [createToolRegistrationHand({
          id: 'remote-browser',
          kind: 'browser',
          tools: [{
            definition: {
              name: 'browser_navigate',
              description: 'Navigate remote browser',
              inputSchema: { type: 'object', properties: {} },
            },
            execute: async () => ({ content: 'ok' }),
          }],
        })],
      }),
    });
    const runtime = built.runtime;

    expect(built.executionEnvironment?.id).toBe('remote-worker');
    expect(runtime.snapshot().tools.map((tool) => tool.name)).toContain('browser_navigate');
    await runtime.dispose();
  });

  it('can let the managed runtime own execution environment disposal', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'berry-runtime-env-dispose-'));
    let disposed = 0;
    const built = createManagedRuntime({
      agentId: 'agent-env-dispose',
      workspace,
      home: new AgentHome(workspace),
      registry,
      credentials: new MemoryCredentialStore(),
      model: 'gpt-test',
      workspaceTools: false,
      webTools: false,
      executionEnvironmentLifetime: 'runtime',
      executionEnvironment: createExecutionEnvironment({
        id: 'owned-worker',
        kind: 'container',
        dispose: () => { disposed += 1; },
      }),
    });

    await built.runtime.dispose();

    expect(disposed).toBe(1);
  });

  it('provisions execution environments from the SDK runtime boundary', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'berry-runtime-env-provider-'));
    const seen: string[] = [];
    let disposed = 0;
    const built = createManagedRuntime({
      agentId: 'agent-env-provider',
      workspace,
      home: new AgentHome(workspace),
      registry,
      credentials: new MemoryCredentialStore(),
      model: 'gpt-test',
      workspaceTools: false,
      webTools: false,
      executionEnvironmentProvider: {
        provision: (request) => {
          seen.push(request.agentId, request.binding.workspace, request.binding.cwd);
          return createExecutionEnvironment({
            id: 'container-a',
            kind: 'container',
            dispose: () => { disposed += 1; },
          });
        },
      },
    });

    const normalizedWorkspace = realpathSync(workspace);
    expect(seen).toEqual(['agent-env-provider', normalizedWorkspace, normalizedWorkspace]);
    expect(built.executionEnvironment?.id).toBe('container-a');

    await built.runtime.dispose();
    expect(disposed).toBe(1);
  });

  it('supports async execution environment providers through createManagedRuntimeAsync', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'berry-runtime-env-provider-async-'));
    const built = await createManagedRuntimeAsync({
      agentId: 'agent-env-provider-async',
      workspace,
      home: new AgentHome(workspace),
      registry,
      credentials: new MemoryCredentialStore(),
      model: 'gpt-test',
      workspaceTools: false,
      webTools: false,
      executionEnvironmentProvider: {
        provision: async () => createExecutionEnvironment({
          id: 'remote-a',
          kind: 'remote',
        }),
      },
    });

    expect(built.executionEnvironment?.id).toBe('remote-a');
    await built.runtime.dispose();
  });

  it('keeps the sync builder honest when provisioning is async', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'berry-runtime-env-provider-sync-'));

    expect(() => createManagedRuntime({
      agentId: 'agent-env-provider-sync',
      workspace,
      home: new AgentHome(workspace),
      registry,
      credentials: new MemoryCredentialStore(),
      model: 'gpt-test',
      workspaceTools: false,
      webTools: false,
      executionEnvironmentProvider: {
        provision: async () => createExecutionEnvironment({
          id: 'remote-b',
          kind: 'remote',
        }),
      },
    })).toThrow(/createManagedRuntimeAsync/);
  });

  it('toggles built-in Hands live and persists the selection to agent.json (B2)', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'berry-runtime-hands-'));
    const built = createManagedRuntime({
      agentId: 'agent-hands',
      workspace,
      home: new AgentHome(workspace),
      registry,
      credentials: new MemoryCredentialStore(),
      model: 'gpt-test',
      // Both built-in hands on (the default — no false flags).
    });
    const runtime = built.runtime;
    const metaPath = new AgentHome(workspace).metadataPath;

    // Both built-ins present at start; agent.json seeded with both.
    expect(runtime.getBuiltinHands().sort()).toEqual(['web', 'workspace']);
    expect(runtime.snapshot().tools.some((t) => t.name === 'web_search')).toBe(true);
    expect(JSON.parse(readFileSync(metaPath, 'utf-8')).hands.builtin.sort())
      .toEqual(['web', 'workspace']);

    // Drop web live — its tools vanish and the on-disk selection updates.
    await runtime.setBuiltinHands(['workspace']);
    expect(runtime.getBuiltinHands()).toEqual(['workspace']);
    expect(runtime.snapshot().tools.some((t) => t.name === 'web_search')).toBe(false);
    expect(JSON.parse(readFileSync(metaPath, 'utf-8')).hands.builtin).toEqual(['workspace']);

    // Re-add web live from the captured builder — no recreate needed.
    await runtime.setBuiltinHands(['workspace', 'web']);
    expect(runtime.snapshot().tools.some((t) => t.name === 'web_search')).toBe(true);
    expect(JSON.parse(readFileSync(metaPath, 'utf-8')).hands.builtin.sort())
      .toEqual(['web', 'workspace']);

    await runtime.dispose();
  });
});

describe('environment prompt helpers', () => {
  it('describe workspace and project bindings once', () => {
    const context = buildEnvironmentContext('/agent-home', '/repo');

    expect(context).toContain('workspace: /agent-home');
    expect(context).toContain('project: /repo');
    expect(context).toContain('cwd: /repo');
    expect(createEnvironmentSystemPrompt('/agent-home', '/repo')[0]?.text).toBe(context);
  });
});
