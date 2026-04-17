// ============================================================
// Berry Agent SDK — MCP Adapter (@berry-agent/mcp)
// ============================================================
// Connects MCP servers and adapts their tools to Berry's
// ToolRegistration interface for seamless agent integration.

export { MCPClient } from './client.js';
export type { MCPClientConfig, MCPTransportConfig, MCPToolOptions } from './types.js';
export { createMCPTools } from './adapter.js';
export { MCPToolCenter, createMCPCenterTools } from './center.js';
export type { MCPServerToolInfo, MCPCenterToolOptions } from './center.js';
