// ============================================================
// @berry-agent/mcp — Schemas (browser-safe)
// ============================================================
// Pure zod schemas + types for MCP server status views. Lives in a
// separate file so host UIs (Claw client) can import them via
// `@berry-agent/mcp/schema` without pulling in MCPClient / stdio /
// child_process — those stay in the root `@berry-agent/mcp` entry.

import { z } from 'zod';

export const MCP_SERVER_STATES = ['connecting', 'connected', 'failed', 'disabled'] as const;
export const mcpServerStatusSchema = z.enum(MCP_SERVER_STATES);
export type MCPServerStatus = z.infer<typeof mcpServerStatusSchema>;

export const mcpServerStatusViewSchema = z.object({
  name: z.string().min(1),
  connected: z.boolean(),
  toolCount: z.number().int().nonnegative(),
  status: mcpServerStatusSchema,
  lastError: z.string().optional(),
  lastStartedAt: z.string().optional(),
}).strict();
export type MCPServerStatusView = z.infer<typeof mcpServerStatusViewSchema>;

export const mcpManagerStatusSchema = z.object({
  shared: z.array(mcpServerStatusViewSchema),
  perAgent: z.record(z.array(mcpServerStatusViewSchema)),
}).strict();
export type MCPManagerStatus = z.infer<typeof mcpManagerStatusSchema>;
