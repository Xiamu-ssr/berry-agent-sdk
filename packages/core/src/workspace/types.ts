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

/** Project context interface — shared knowledge across agents. */
export interface ProjectContext {
  /** Project root directory. */
  readonly root: string;
  /** Load project context files (e.g., AGENTS.md, PROJECT.md). Returns empty string if none found. */
  loadContext(): Promise<string>;
  /** Append a discovery to project knowledge (.berry-discoveries.md). */
  appendDiscovery(content: string): Promise<void>;
}
