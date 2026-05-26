// ============================================================
// Berry Agent SDK — MCP Adapter (@berry-agent/mcp)
// ============================================================
// Connects MCP servers and adapts their tools to Berry's
// ToolRegistration interface for seamless agent integration.

export { MCPClient } from './client.js';
export type { MCPClientConfig, MCPTransportConfig, MCPToolOptions } from './types.js';
export { createMCPHand, createMCPTools, defaultMCPPrefix, MCP_DEFAULT_PREFIX_SEPARATOR } from './adapter.js';
export { MCPToolCenter, createMCPCenterTools } from './center.js';
export type { MCPServerToolInfo, MCPCenterToolOptions } from './center.js';
export { MCPManager } from './manager.js';
export type {
  MCPClientFactoryConfig,
  MCPManagerOptions,
  MCPServerStatus,
  MCPServerStatusView,
} from './manager.js';

// Configuration cascade (load N `.mcp.json` files, field-level merge).
export {
  MCP_CONFIG_FILENAME,
  createNodePackageBinResolver,
  ensureDefaultPlaywrightMCPConfig,
  ensureMCPConfigFile,
  loadMCPLayer,
  loadMergedMCPConfig,
  mergeMCPConfigs,
  normalizeDefaultMCPServerConfig,
  normalizeMCPConfigRecord,
  normalizeMCPServerConfig,
} from './config.js';
export type {
  LoadMergedMCPConfigOptions,
  MCPLayerSpec,
  EnsureMCPConfigFileOptions,
  MCPNpxPackageRewrite,
  MCPPackageBinResolver,
  MCPServerConfig,
  NormalizeMCPServerConfigOptions,
} from './config.js';
export {
  DEFAULT_PLAYWRIGHT_MCP_BIN,
  DEFAULT_PLAYWRIGHT_MCP_PACKAGE,
  DEFAULT_PLAYWRIGHT_MCP_TEMPLATE,
} from './defaults.js';
