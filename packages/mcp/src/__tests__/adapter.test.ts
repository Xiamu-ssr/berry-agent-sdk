import { describe, it, expect, vi } from 'vitest';
import { createMCPTools } from '../adapter.js';
import type { MCPClient, MCPToolInfo } from '../client.js';

/** Create a fake MCPClient for testing. */
function createFakeMCPClient(tools: MCPToolInfo[]): MCPClient {
  const callResults = new Map<string, { content: string; isError: boolean }>();

  return {
    name: 'test-server',
    connected: true,
    connect: vi.fn(),
    disconnect: vi.fn(),
    listTools: vi.fn(async () => tools),
    callTool: vi.fn(async (name: string, _input: Record<string, unknown>) => {
      return callResults.get(name) ?? { content: `result from ${name}`, isError: false };
    }),
    _setResult(name: string, content: string, isError = false) {
      callResults.set(name, { content, isError });
    },
  } as unknown as MCPClient & { _setResult: (name: string, content: string, isError?: boolean) => void };
}

const sampleTools: MCPToolInfo[] = [
  {
    name: 'read_file',
    description: 'Read a file from disk',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path' },
      },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description: 'Write content to a file',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'search',
    description: 'Search the web',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
      },
      required: ['query'],
    },
  },
];

describe('createMCPTools', () => {
  it('converts MCP tools to Berry ToolRegistrations', async () => {
    const client = createFakeMCPClient(sampleTools);
    const tools = await createMCPTools(client);

    expect(tools).toHaveLength(3);
    expect(tools.map(t => t.definition.name)).toEqual(['read_file', 'write_file', 'search']);
    expect(tools[0].definition.description).toBe('Read a file from disk');
    expect(tools[0].definition.inputSchema.required).toEqual(['path']);
  });

  it('applies prefix to tool names', async () => {
    const client = createFakeMCPClient(sampleTools);
    const tools = await createMCPTools(client, { prefix: 'fs_' });

    expect(tools.map(t => t.definition.name)).toEqual(['fs_read_file', 'fs_write_file', 'fs_search']);
  });

  it('filters tools with include list', async () => {
    const client = createFakeMCPClient(sampleTools);
    const tools = await createMCPTools(client, { include: ['read_file', 'search'] });

    expect(tools).toHaveLength(2);
    expect(tools.map(t => t.definition.name)).toEqual(['read_file', 'search']);
  });

  it('filters tools with exclude list', async () => {
    const client = createFakeMCPClient(sampleTools);
    const tools = await createMCPTools(client, { exclude: ['search'] });

    expect(tools).toHaveLength(2);
    expect(tools.map(t => t.definition.name)).toEqual(['read_file', 'write_file']);
  });

  it('include works with prefix (matches both prefixed and original names)', async () => {
    const client = createFakeMCPClient(sampleTools);
    const tools = await createMCPTools(client, { prefix: 'mcp_', include: ['mcp_read_file'] });

    expect(tools).toHaveLength(1);
    expect(tools[0].definition.name).toBe('mcp_read_file');
  });

  it('executes tool calls through the MCP client', async () => {
    const client = createFakeMCPClient(sampleTools);
    const tools = await createMCPTools(client);

    const readTool = tools.find(t => t.definition.name === 'read_file')!;
    const result = await readTool.execute(
      { path: '/tmp/test.txt' },
      { cwd: '/tmp' },
    );

    expect(result.content).toBe('result from read_file');
    expect(result.isError).toBeFalsy();
    expect((client as any).callTool).toHaveBeenCalledWith('read_file', { path: '/tmp/test.txt' });
  });

  it('passes through error results from MCP', async () => {
    const client = createFakeMCPClient(sampleTools) as any;
    client._setResult('read_file', 'File not found', true);

    const tools = await createMCPTools(client);
    const readTool = tools.find(t => t.definition.name === 'read_file')!;
    const result = await readTool.execute({ path: '/nonexistent' }, { cwd: '/' });

    expect(result.content).toBe('File not found');
    expect(result.isError).toBe(true);
  });

  it('returns empty array for server with no tools', async () => {
    const client = createFakeMCPClient([]);
    const tools = await createMCPTools(client);

    expect(tools).toEqual([]);
  });

  it('uses original MCP tool name when calling (not prefixed name)', async () => {
    const client = createFakeMCPClient(sampleTools);
    const tools = await createMCPTools(client, { prefix: 'mcp_' });

    const readTool = tools.find(t => t.definition.name === 'mcp_read_file')!;
    await readTool.execute({ path: '/test' }, { cwd: '/' });

    // Should call MCP with the original name, not the prefixed one
    expect((client as any).callTool).toHaveBeenCalledWith('read_file', { path: '/test' });
  });
});
