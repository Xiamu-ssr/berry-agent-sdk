// ============================================================
// @berry-agent/machine-connector — Local MCP host
// ============================================================
// Connects to the MCP servers declared in this machine's local .mcp.json,
// lists their tools to build the manifest reported to a8s at registration,
// and dispatches invoke(server, name, input) calls back to the right
// MCPClient.
//
// Design (per the settled machine-layer model): the persistent stdio
// connection to each MCP server lives entirely here, on the machine.
// a8s stays MCP-agnostic — it only forwards a one-shot {server, name,
// input} invoke. So the brain → a8s → connector hop is request/reply
// (exactly like exec), and the connector → MCP-server hop is the
// long-lived stdio session. The user's existing .mcp.json is used
// verbatim; nothing about their MCP setup changes.

import { loadMergedMCPConfig, MCPClient, type MCPServerConfig } from '@berry-agent/mcp';
import type { MachineMcpManifest, MachineMcpTool } from '@berry-agent/cluster-protocol';

export interface MachineMcpHostOptions {
  /** Absolute path to the machine's .mcp.json. */
  configPath: string;
  /** Per-server connect timeout. Defaults to 10s (MCPClient default). */
  connectTimeoutMs?: number;
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
}

/**
 * Owns the live MCPClient connections for one machine and exposes a flat
 * manifest + an invoke dispatcher. Start once at connector boot; dispose
 * at shutdown.
 */
export class MachineMcpHost {
  private readonly clients = new Map<string, MCPClient>();
  private readonly tools: MachineMcpTool[] = [];
  private readonly logger: Pick<Console, 'log' | 'warn' | 'error'>;
  private readonly options: MachineMcpHostOptions;

  constructor(options: MachineMcpHostOptions) {
    this.options = options;
    this.logger = options.logger ?? console;
  }

  /**
   * Read .mcp.json, connect every enabled server, and list its tools.
   * Servers that fail to connect are logged and skipped — one broken MCP
   * server must not stop the connector from offering the rest (and exec).
   */
  async start(): Promise<void> {
    let servers: Record<string, MCPServerConfig>;
    try {
      servers = loadMergedMCPConfig({
        layers: [{ filePath: this.options.configPath, label: 'machine' }],
      });
    } catch (err) {
      this.logger.warn?.(`[machine-connector] could not read MCP config ${this.options.configPath}: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    for (const [name, cfg] of Object.entries(servers)) {
      if (!cfg.enabled) continue;
      const client = new MCPClient({
        name,
        transport: cfg.transport,
        connectTimeoutMs: this.options.connectTimeoutMs,
      });
      try {
        await client.connect();
        const list = await client.listTools();
        for (const t of list) {
          this.tools.push({
            server: name,
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema as Record<string, unknown> | undefined,
          });
        }
        this.clients.set(name, client);
        this.logger.log?.(`[machine-connector] MCP "${name}": ${list.length} tool(s)`);
      } catch (err) {
        this.logger.warn?.(`[machine-connector] MCP "${name}" failed to connect; skipping: ${err instanceof Error ? err.message : String(err)}`);
        await client.disconnect().catch(() => {});
      }
    }
  }

  /** Flat manifest reported to a8s at registration. */
  manifest(): MachineMcpManifest {
    return { tools: [...this.tools] };
  }

  /** Server ids successfully connected (for the lightweight mcpServers list). */
  serverIds(): string[] {
    return [...this.clients.keys()];
  }

  /** Dispatch one MCP tool call to its server. Returns stringified content. */
  async invoke(server: string, name: string, input: Record<string, unknown>): Promise<{ content: string; isError?: boolean }> {
    const client = this.clients.get(server);
    if (!client) {
      return { content: `machine has no connected MCP server "${server}"`, isError: true };
    }
    const result = await client.callTool(name, input);
    return { content: result.content, isError: result.isError };
  }

  async dispose(): Promise<void> {
    await Promise.allSettled([...this.clients.values()].map((c) => c.disconnect()));
    this.clients.clear();
  }
}
