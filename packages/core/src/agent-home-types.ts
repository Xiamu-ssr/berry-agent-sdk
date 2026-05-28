// ============================================================
// Berry Agent SDK — AgentHome types
// ============================================================
// Pure interface types extracted from agent-home.ts so browser hosts
// (Claw client) can import them without dragging in node:fs/promises
// or node:path. The runtime `AgentHome` class still lives in
// agent-home.ts and continues to expose the same surface.

export interface AgentHomeSnapshot {
  root: string;
  sessionsDir: string;
  skillsDir: string;
  mcpConfigPath: string;
  memoryPath: string;
  agentMdPath: string;
  metadataPath: string;
}
