// ============================================================
// Berry Agent SDK — Workspace Type Definitions
// ============================================================

/** Agent workspace configuration. */
export interface WorkspaceConfig {
  /** Root directory of agent workspace. */
  root: string;
  /** Initialize workspace if it doesn't exist (default: true). */
  autoInit?: boolean;
}

/** Agent memory interface — per-agent long-term memory. */
export interface AgentMemory {
  /** Load full memory content. Returns empty string if memory file doesn't exist. */
  load(): Promise<string>;
  /** Append content to memory with a timestamp header. */
  append(content: string): Promise<void>;
  /** Replace full memory content. */
  write(content: string): Promise<void>;
  /** Check if memory file exists. */
  exists(): Promise<boolean>;
}

/** Project context interface — shared knowledge across agents. Agents read it; hosts may expose human editing through SDK APIs. */
export interface ProjectContext {
  /** Project root directory. */
  readonly root: string;
  /** Load the SDK project context file. Returns empty string if not present. */
  loadContext(): Promise<string>;
  /** Replace the SDK project context file. Intended for human/host editing, not agent self-mutation. */
  writeContext(content: string): Promise<void>;
}
