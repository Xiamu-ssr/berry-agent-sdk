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
  // Track sanitized names per server so we can warn on collisions.
  const seen = new Set<string>();

  for (const tool of mcpTools) {
    const rawName = prefix + tool.name;
    // Provider APIs (Anthropic / OpenAI / Moonshot / OpenRouter) enforce
    // function names matching /^[a-zA-Z][a-zA-Z0-9_-]*$/. Upstream MCP
    // servers sometimes expose dotted / colon-separated names (e.g.
    // `product-project.create_draft`) — if we forward those verbatim the
    // whole request fails with `invalid_request_error`. Sanitize once
    // here; execute() still dispatches using the original `tool.name`.
    const berryName = sanitizeToolName(rawName);
    if (berryName !== rawName) {
      console.warn(
        `[mcp:${client.name}] tool name "${rawName}" contains characters disallowed by provider APIs; rewrote to "${berryName}"`,
      );
    }
    if (seen.has(berryName)) {
      // Two upstream tools sanitize to the same name — drop the later one
      // rather than crashing the whole agent.
      console.warn(
        `[mcp:${client.name}] sanitized tool name "${berryName}" collides with an earlier tool; skipping "${tool.name}"`,
      );
      continue;
    }
    seen.add(berryName);

    // Filters accept either the sanitized name or the original so existing
    // include/exclude configs keep working regardless of which form the
    // user wrote.
    if (include && !include.has(berryName) && !include.has(rawName) && !include.has(tool.name)) continue;
    if (exclude && (exclude.has(berryName) || exclude.has(rawName) || exclude.has(tool.name))) continue;

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
      // Provenance so downstream fact/UI code can attribute tools back to
      // the upstream server without re-parsing the `${prefix}name` convention.
      source: { kind: 'mcp', server: client.name },
    });
  }

  return registrations;
}

/**
 * Make an upstream MCP tool name conform to provider-side function-naming
 * rules: `^[a-zA-Z][a-zA-Z0-9_-]*$`.
 *
 * - Replaces every disallowed character (dots, slashes, colons, spaces,
 *   unicode, ...) with an underscore.
 * - If the result doesn't start with a letter, prefix with `t_` so the
 *   leading-letter rule is satisfied.
 * - Empty input (shouldn't happen) falls back to `tool`.
 *
 * The transformation is deterministic so collisions are discoverable and
 * we can warn instead of silently doubling up.
 */
function sanitizeToolName(name: string): string {
  if (!name) return 'tool';
  const replaced = name.replace(/[^a-zA-Z0-9_-]/g, '_');
  if (/^[a-zA-Z]/.test(replaced)) return replaced;
  return `t_${replaced}`;
}
