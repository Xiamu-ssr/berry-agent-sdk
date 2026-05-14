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
  /**
   * Hard timeout (ms) for `connect()` and `listTools()`. The underlying
   * `@modelcontextprotocol/sdk` has a 60s default baked into `initialize`,
   * which is too long for cold-start hosts that want to skip unhealthy
   * servers and move on. Defaults to 10_000.
   */
  connectTimeoutMs?: number;
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
  /**
   * Explicit prefix to add to every tool name. When set, always applied
   * verbatim (including the empty string meaning "no prefix"). Takes
   * precedence over `autoPrefix`.
   */
  prefix?: string;
  /**
   * Fallback prefix used only when `prefix` is undefined. The adapter checks
   * whether every upstream tool's name already starts with this prefix
   * (case-insensitive, either `_` or `-` separator); if so it skips prefixing
   * to avoid double-prefix ugliness (e.g. `skylark_skylark_doc_detail`).
   * Otherwise the value is applied literally.
   */
  autoPrefix?: string;
  /** Only include these tool names (after prefix). */
  include?: string[];
  /** Exclude these tool names (after prefix). */
  exclude?: string[];
}
