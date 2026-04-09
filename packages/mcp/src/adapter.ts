// ============================================================
// Berry Agent SDK — MCP → Berry Tool Adapter
// ============================================================
// Converts MCP server tools into Berry ToolRegistration[].
// Usage:
//   const tools = await createMCPTools(mcpClient, { prefix: 'mcp_' });
//   const agent = new Agent({ tools, ... });

import type { ToolRegistration, ToolDefinition } from '@berry-agent/core';
import type { MCPClient } from './client.js';
import type { MCPToolOptions } from './types.js';

/**
 * Discover tools from an MCP server and wrap them as Berry ToolRegistrations.
 *
 * Each MCP tool becomes a Berry tool that:
 * 1. Has the same name (optionally prefixed)
 * 2. Has the same input schema
 * 3. Calls the MCP server when executed
 *
 * @param client Connected MCPClient instance
 * @param options Optional filtering and naming options
 * @returns Array of Berry ToolRegistrations ready for Agent config
 */
export async function createMCPTools(
  client: MCPClient,
  options?: MCPToolOptions,
): Promise<ToolRegistration[]> {
  const prefix = options?.prefix ?? '';
  const include = options?.include ? new Set(options.include) : null;
  const exclude = options?.exclude ? new Set(options.exclude) : null;

  const mcpTools = await client.listTools();
  const registrations: ToolRegistration[] = [];

  for (const tool of mcpTools) {
    const berryName = prefix + tool.name;

    // Apply filters
    if (include && !include.has(berryName) && !include.has(tool.name)) continue;
    if (exclude && (exclude.has(berryName) || exclude.has(tool.name))) continue;

    const definition: ToolDefinition = {
      name: berryName,
      description: tool.description,
      inputSchema: tool.inputSchema,
    };

    registrations.push({
      definition,
      execute: async (input: Record<string, unknown>) => {
        const result = await client.callTool(tool.name, input);
        return {
          content: result.content,
          isError: result.isError,
        };
      },
    });
  }

  return registrations;
}
