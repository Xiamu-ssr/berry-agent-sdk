import type { HandKind } from './hands.js';

/**
 * Tool group enum — semantic categorization for UI display and permission
 * scoping. Set on `ToolDefinition.group`; defaults to Other when omitted.
 */
export enum ToolGroup {
  /** File system read/write/list: read_file, write_file, edit_file, list_files. */
  File = 'file',
  /** Command execution and process management: shell, process_list, etc. */
  Shell = 'shell',
  /** Code/content search within project: grep, find_files. */
  Search = 'search',
  /** Internet access: web_search, web_fetch, browser. */
  Web = 'web',
  /** Agent knowledge persistence: save_memory, memory_search, memory_get. */
  Memory = 'memory',
  /** Multi-agent collaboration: spawn_teammate, message_leader, etc. */
  Team = 'team',
  /** Agent self-management: load_skill, delegate, todo_read/write, sleep. */
  Agent = 'agent',
  /** Host platform introspection: berry_status, berry_config_get, etc. */
  System = 'system',
  /** Default / ungrouped: MCP dynamic tools, custom tools, etc. */
  Other = 'other',
}

/** Human-readable labels for each ToolGroup. */
export const TOOL_GROUP_LABELS: Record<ToolGroup, string> = {
  [ToolGroup.File]: 'File',
  [ToolGroup.Shell]: 'Shell',
  [ToolGroup.Search]: 'Search',
  [ToolGroup.Web]: 'Web',
  [ToolGroup.Memory]: 'Memory',
  [ToolGroup.Team]: 'Team',
  [ToolGroup.Agent]: 'Agent',
  [ToolGroup.System]: 'System',
  [ToolGroup.Other]: 'Other',
};

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
  /** Tool group for categorization. */
  group?: ToolGroup;
}

export interface ToolRegistration {
  definition: ToolDefinition;
  execute: (input: Record<string, unknown>, context: ToolContext) => Promise<ToolResult>;
  /** Release resources owned by this tool registration, such as background processes. */
  dispose?: () => Promise<void> | void;
  /**
   * Provenance of the tool. Omitted means built-in application registration.
   * MCP/hand adapters stamp source so UIs can attribute tools without
   * re-parsing model-visible names.
   */
  source?: {
    kind: 'builtin' | 'mcp' | 'hand';
    /** MCP server name (upstream, no prefix). Only set when kind is mcp. */
    server?: string;
    /** Hand id. Only set when kind is hand. */
    hand?: string;
    /** Hand kind. Only set when kind is hand. */
    handKind?: HandKind;
  };
}

export interface ToolContext {
  cwd: string;
  abortSignal?: AbortSignal;
}

export interface ToolResult {
  content: string;
  isError?: boolean;
  /** Content for the LLM, which may differ from what the user sees. */
  forLLM?: string;
  /** Content for the user. */
  forUser?: string;
}

export type ToolGuard = (context: ToolGuardContext) => Promise<ToolGuardDecision>;

export interface ToolGuardContext {
  /** Tool being called. */
  toolName: string;
  /** Input arguments. */
  input: Record<string, unknown>;
  /** Session info supplied by the agent instance. */
  session: { id: string; cwd: string; model: string; turnId?: string };
  /** Sequential index of this tool call within the current query. */
  callIndex: number;
}

export type ToolGuardDecision =
  | { action: 'allow' }
  | { action: 'deny'; reason: string }
  | { action: 'modify'; input: Record<string, unknown> };
