// ============================================================
// Berry Agent SDK — MCP Types
// ============================================================

/** Configuration for connecting to an MCP server. */
export interface MCPClientConfig {
  /** Human-readable name for this MCP connection. */
  name: string;
  /** Transport configuration. */
  transport: MCPTransportConfig;
  /** Client info sent during initialization. */
  clientInfo?: {
    name: string;
    version: string;
  };
}

/** Transport configuration — stdio (local process) or HTTP (remote). */
export type MCPTransportConfig =
  | StdioTransportConfig
  | StreamableHttpTransportConfig;

export interface StdioTransportConfig {
  type: 'stdio';
  /** Command to spawn the MCP server process. */
  command: string;
  /** Arguments to pass to the command. */
  args?: string[];
  /** Environment variables for the spawned process. */
  env?: Record<string, string>;
  /** Working directory for the spawned process. */
  cwd?: string;
}

export interface StreamableHttpTransportConfig {
  type: 'http';
  /** URL of the MCP server's Streamable HTTP endpoint. */
  url: string;
  /** Additional headers for HTTP requests. */
  headers?: Record<string, string>;
}

/** Options for tool creation from MCP. */
export interface MCPToolOptions {
  /** Prefix to add to tool names (avoids conflicts between multiple servers). */
  prefix?: string;
  /** Only include these tool names (after prefix). */
  include?: string[];
  /** Exclude these tool names (after prefix). */
  exclude?: string[];
}
