import { describe, it, expect, vi } from 'vitest';
import { MCPToolCenter, createMCPCenterTools } from '../center.js';
import type { MCPClient, MCPToolInfo } from '../client.js';

function createFakeMCPClient(name: string, tools: MCPToolInfo[]): MCPClient {
  return {
    name,
    connected: true,
    connect: vi.fn(),
    disconnect: vi.fn(),
    listTools: vi.fn(async () => tools),
    callTool: vi.fn(async (toolName: string, input: Record<string, unknown>) => ({
      content: `${name}:${toolName}:${JSON.stringify(input)}`,
      isError: false,
    })),
  } as unknown as MCPClient;
}

describe('MCPToolCenter', () => {
  const fsTools: MCPToolInfo[] = [
    {
      name: 'read_file',
      description: 'Read file',
      inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    },
  ];

  const webTools: MCPToolInfo[] = [
    {
      name: 'search',
      description: 'Search web',
      inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    },
  ];

  it('lists tools across multiple registered servers', async () => {
    const center = new MCPToolCenter();
    center.register(createFakeMCPClient('fs', fsTools));
    center.register(createFakeMCPClient('web', webTools));

    const tools = await center.listTools();

    expect(tools).toHaveLength(2);
    expect(tools).toEqual([
      expect.objectContaining({ server: 'fs', name: 'read_file' }),
      expect.objectContaining({ server: 'web', name: 'search' }),
    ]);
  });

  it('calls a tool on the selected server', async () => {
    const fs = createFakeMCPClient('fs', fsTools) as unknown as { callTool: ReturnType<typeof vi.fn> } & MCPClient;
    const center = new MCPToolCenter();
    center.register(fs);

    const result = await center.callTool('fs', 'read_file', { path: '/tmp/a.txt' });

    expect(result.content).toContain('fs:read_file');
    expect(fs.callTool).toHaveBeenCalledWith('read_file', { path: '/tmp/a.txt' });
  });

  it('creates second-class center tools for agents', async () => {
    const center = new MCPToolCenter();
    center.register(createFakeMCPClient('fs', fsTools));

    const tools = createMCPCenterTools(center);
    expect(tools.map(tool => tool.definition.name)).toEqual(['list_mcp_tools', 'use_mcp']);

    const listTool = tools[0]!;
    const useTool = tools[1]!;

    const listed = await listTool.execute({}, { cwd: '/' });
    expect(listed.content).toContain('"server": "fs"');
    expect(listed.content).toContain('"name": "read_file"');

    const used = await useTool.execute({ server: 'fs', tool: 'read_file', input: { path: '/x' } }, { cwd: '/' });
    expect(used.content).toContain('fs:read_file');
  });

  it('returns validation error for invalid use_mcp input', async () => {
    const center = new MCPToolCenter();
    const [, useTool] = createMCPCenterTools(center);

    const result = await useTool!.execute({ server: 'fs', tool: 'read_file', input: 'bad' as unknown as Record<string, unknown> }, { cwd: '/' });

    expect(result.isError).toBe(true);
    expect(result.content).toContain('Invalid input');
  });
});
