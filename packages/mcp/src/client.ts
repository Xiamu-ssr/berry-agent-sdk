// ============================================================
// Berry Agent SDK — MCP Client
// ============================================================
// Wraps @modelcontextprotocol/sdk Client with lifecycle management.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { MCPClientConfig } from './types.js';

export class MCPClient {
  readonly name: string;
  private client: Client;
  private transport: Transport | null = null;
  private config: MCPClientConfig;
  private _connected = false;

  constructor(config: MCPClientConfig) {
    this.name = config.name;
    this.config = config;
    this.client = new Client(
      config.clientInfo ?? { name: 'berry-agent-mcp', version: '0.1.0' },
    );
  }

  /** Whether the client is currently connected. */
  get connected(): boolean {
    return this._connected;
  }

  /** Connect to the MCP server. Must be called before listing/calling tools. */
  async connect(): Promise<void> {
    if (this._connected) return;

    this.transport = this.createTransport();
    await this.client.connect(this.transport);
    this._connected = true;
  }

  /** Disconnect from the MCP server. */
  async disconnect(): Promise<void> {
    if (!this._connected) return;

    try {
      await this.client.close();
    } finally {
      this._connected = false;
      this.transport = null;
    }
  }

  /** List available tools from the MCP server. */
  async listTools(): Promise<MCPToolInfo[]> {
    this.ensureConnected();
    const result = await this.client.listTools();
    return (result.tools ?? []).map(tool => ({
      name: tool.name,
      description: tool.description ?? '',
      inputSchema: (tool.inputSchema ?? { type: 'object', properties: {} }) as {
        type: 'object';
        properties: Record<string, unknown>;
        required?: string[];
      },
    }));
  }

  /** Call a tool on the MCP server. */
  async callTool(name: string, input: Record<string, unknown>): Promise<MCPToolResult> {
    this.ensureConnected();
    const result = await this.client.callTool({ name, arguments: input });

    // Extract text content from MCP result
    const blocks = (result.content ?? []) as Array<{ type: string; text?: string; resource?: { uri?: string } }>;
    const content = blocks
      .map((block) => {
        if (block.type === 'text') return block.text ?? '';
        if (block.type === 'image') return '[image]';
        if (block.type === 'resource') return `[resource: ${block.resource?.uri ?? 'unknown'}]`;
        return JSON.stringify(block);
      })
      .join('\n');

    return {
      content,
      isError: (result.isError as boolean | undefined) ?? false,
    };
  }

  private createTransport(): Transport {
    const tc = this.config.transport;
    switch (tc.type) {
      case 'stdio':
        return new StdioClientTransport({
          command: tc.command,
          args: tc.args,
          env: tc.env
            ? Object.fromEntries(
                Object.entries({ ...process.env, ...tc.env })
                  .filter((pair): pair is [string, string] => pair[1] !== undefined),
              )
            : undefined,
          cwd: tc.cwd,
        });
      case 'http':
        return new StreamableHTTPClientTransport(
          new URL(tc.url),
          { requestInit: tc.headers ? { headers: tc.headers } : undefined },
        );
      default:
        throw new Error(`Unknown MCP transport type: ${(tc as { type: string }).type}`);
    }
  }

  private ensureConnected(): void {
    if (!this._connected) {
      throw new Error(`MCP client "${this.name}" is not connected. Call connect() first.`);
    }
  }
}

/** Tool info returned from MCP server. */
export interface MCPToolInfo {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

/** Tool call result from MCP server. */
export interface MCPToolResult {
  content: string;
  isError: boolean;
}
