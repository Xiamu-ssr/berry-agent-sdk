import { describe, expect, it, vi } from 'vitest';
import { MCPManager } from '../manager.js';
import type { MCPClient } from '../client.js';
import type { MCPServerConfig } from '../config.js';

function config(overrides: Partial<MCPServerConfig> = {}): MCPServerConfig {
  return {
    transport: { type: 'stdio', command: 'test-mcp' },
    shared: false,
    prefix: undefined,
    enabled: true,
    layer: 'agent',
    ...overrides,
  };
}

function fakeClient(options: {
  name?: string;
  tools?: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>;
  connect?: () => Promise<void>;
  disconnect?: () => Promise<void>;
} = {}): MCPClient {
  return {
    name: options.name ?? 'fake',
    connect: vi.fn(options.connect ?? (async () => {})),
    disconnect: vi.fn(options.disconnect ?? (async () => {})),
    listTools: vi.fn(async () => options.tools ?? [
      { name: 'read', description: 'Read', inputSchema: { type: 'object' } },
    ]),
    callTool: vi.fn(async () => ({ content: 'ok' })),
  } as unknown as MCPClient;
}

describe('MCPManager', () => {
  it('connects shared servers and exposes status plus hands', async () => {
    const onChange = vi.fn();
    const client = fakeClient({
      name: 'docs',
      tools: [
        { name: 'search', description: 'Search', inputSchema: { type: 'object' } },
        { name: 'read', description: 'Read', inputSchema: { type: 'object' } },
      ],
    });
    const manager = new MCPManager({
      now: () => new Date('2026-05-23T00:00:00.000Z'),
      onChange,
      clientFactory: () => client,
    });

    await manager.startSharedServers({ docs: config({ shared: true, layer: 'global' }) });

    expect(manager.getStatus().shared).toEqual([{
      name: 'docs',
      connected: true,
      toolCount: 2,
      status: 'connected',
      lastStartedAt: '2026-05-23T00:00:00.000Z',
    }]);
    expect(manager.getHandsForAgent('agent_1').map((hand) => hand.id)).toEqual(['mcp:docs']);
    expect(onChange).toHaveBeenCalled();
  });

  it('retains failed servers in status without throwing startup', async () => {
    const manager = new MCPManager({
      now: () => new Date('2026-05-23T00:00:00.000Z'),
      clientFactory: () => fakeClient({
        connect: async () => { throw new Error('boom'); },
      }),
    });

    await manager.startAgentServers('agent_1', { bad: config() });

    expect(manager.getStatus().perAgent.agent_1).toEqual([{
      name: 'bad',
      connected: false,
      toolCount: 0,
      status: 'failed',
      lastError: 'boom',
      lastStartedAt: '2026-05-23T00:00:00.000Z',
    }]);
  });

  it('disables servers without connecting and clears agent servers on release', async () => {
    const client = fakeClient();
    const disconnect = vi.mocked(client.disconnect);
    const manager = new MCPManager({ clientFactory: () => client });

    await manager.startAgentServers('agent_1', { disabled: config({ enabled: false }) });
    expect(manager.getStatus().perAgent.agent_1?.[0]?.status).toBe('disabled');
    expect(vi.mocked(client.connect)).not.toHaveBeenCalled();

    await manager.restartAgent('agent_1', 'enabled', config());
    expect(manager.getStatus().perAgent.agent_1).toHaveLength(2);

    await manager.releaseAgent('agent_1');
    expect(manager.getStatus().perAgent.agent_1).toBeUndefined();
    expect(disconnect).toHaveBeenCalledTimes(1);
  });
});
