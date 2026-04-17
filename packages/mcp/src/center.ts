// ============================================================
// Berry Agent SDK — MCP Tool Center
// ============================================================
// Keeps external MCP servers as second-class citizens:
// register many MCP servers centrally, then expose a small first-class
// interface like `list_mcp_tools` and `use_mcp` to the model.

import type { ToolRegistration, ToolDefinition } from '@berry-agent/core';
import type { MCPClient, MCPToolInfo, MCPToolResult } from './client.js';

export interface MCPServerToolInfo extends MCPToolInfo {
  server: string;
}

export interface MCPCenterToolOptions {
  /** Tool name for listing available MCP tools. Default: list_mcp_tools */
  listToolName?: string;
  /** Tool name for invoking an MCP tool. Default: use_mcp */
  useToolName?: string;
}

export class MCPToolCenter {
  private clients = new Map<string, MCPClient>();

  register(client: MCPClient): void {
    this.clients.set(client.name, client);
  }

  unregister(name: string): boolean {
    return this.clients.delete(name);
  }

  getClient(name: string): MCPClient | undefined {
    return this.clients.get(name);
  }

  listServers(): string[] {
    return [...this.clients.keys()].sort();
  }

  async connectAll(): Promise<void> {
    await Promise.all([...this.clients.values()].map(client => client.connect()));
  }

  async disconnectAll(): Promise<void> {
    await Promise.all([...this.clients.values()].map(client => client.disconnect()));
  }

  async listTools(server?: string): Promise<MCPServerToolInfo[]> {
    if (server) {
      const client = this.clients.get(server);
      if (!client) throw new Error(`Unknown MCP server: ${server}`);
      const tools = await client.listTools();
      return tools.map(tool => ({ ...tool, server }));
    }

    const all: MCPServerToolInfo[] = [];
    for (const [name, client] of this.clients) {
      const tools = await client.listTools();
      all.push(...tools.map(tool => ({ ...tool, server: name })));
    }
    return all;
  }

  async callTool(server: string, tool: string, input: Record<string, unknown>): Promise<MCPToolResult> {
    const client = this.clients.get(server);
    if (!client) throw new Error(`Unknown MCP server: ${server}`);
    return client.callTool(tool, input);
  }
}

export function createMCPCenterTools(
  center: MCPToolCenter,
  options?: MCPCenterToolOptions,
): ToolRegistration[] {
  const listToolName = options?.listToolName ?? 'list_mcp_tools';
  const useToolName = options?.useToolName ?? 'use_mcp';

  const listDefinition: ToolDefinition = {
    name: listToolName,
    description: 'List external MCP tools registered in the MCP center. Use this before calling use_mcp when you are unsure which server or tool to use.',
    inputSchema: {
      type: 'object',
      properties: {
        server: {
          type: 'string',
          description: 'Optional MCP server name to filter by.',
        },
      },
    },
  };

  const useDefinition: ToolDefinition = {
    name: useToolName,
    description: 'Call a tool from an external MCP server registered in the MCP center.',
    inputSchema: {
      type: 'object',
      properties: {
        server: {
          type: 'string',
          description: 'Registered MCP server name.',
        },
        tool: {
          type: 'string',
          description: 'Tool name exposed by that MCP server.',
        },
        input: {
          type: 'object',
          description: 'JSON input object to pass to the MCP tool.',
          properties: {},
        },
      },
      required: ['server', 'tool', 'input'],
    },
  };

  return [
    {
      definition: listDefinition,
      execute: async (input) => {
        const server = typeof input.server === 'string' ? input.server : undefined;
        const tools = await center.listTools(server);
        const grouped = new Map<string, Array<{ name: string; description: string }>>();
        for (const tool of tools) {
          const existing = grouped.get(tool.server) ?? [];
          existing.push({ name: tool.name, description: tool.description });
          grouped.set(tool.server, existing);
        }
        return {
          content: JSON.stringify(
            [...grouped.entries()].map(([serverName, serverTools]) => ({
              server: serverName,
              tools: serverTools,
            })),
            null,
            2,
          ),
        };
      },
    },
    {
      definition: useDefinition,
      execute: async (input) => {
        const server = input.server;
        const tool = input.tool;
        const toolInput = input.input;
        if (typeof server !== 'string' || typeof tool !== 'string' || !toolInput || typeof toolInput !== 'object' || Array.isArray(toolInput)) {
          return {
            content: 'Invalid input: expected { server: string, tool: string, input: object }',
            isError: true,
          };
        }
        const result = await center.callTool(server, tool, toolInput as Record<string, unknown>);
        return {
          content: result.content,
          isError: result.isError,
        };
      },
    },
  ];
}
