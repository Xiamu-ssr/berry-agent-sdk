// ============================================================
// Berry Agent SDK — AgentHome
// ============================================================
//
// Directory-layout contract for a single Agent's on-disk data.
//
// Ownership rule (the whole reason this file exists):
//
//   - The **product** embedding the SDK decides the *root* directory.
//     e.g. a product might pick `<app-data>/agents/<id>/`.
//
//   - The **SDK** decides every subpath under that root. Session stores,
//     event logs, agent-local skills, the agent-local MCP config,
//     the agent's system-prompt snippet (AGENTS.md), the agent's long-term
//     memory (MEMORY.md), and the metadata file (agent.json) all live at
//     paths the SDK dictates. Products call getters instead of
//     reconstructing these paths inline.
//
// This split keeps products free to choose branding / multi-tenant layout
// while guaranteeing SDK components (FileSessionStore, FileEventLogStore,
// FileAgentMemory, skill loader) always find each other in the same
// place. Changing the layout is a one-line diff here instead of a
// whack-a-mole across the product tree.
//
// Global resources — global skill pools, org-wide MCP configs — stay the
// product's concern and are passed to the SDK via separate discovery
// inputs (e.g. `skillDirs`), not through AgentHome.
//
// Construction is pure (no I/O). Call `ensure()` to create the tree.

import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';

export class AgentHome {
  readonly root: string;

  constructor(root: string) {
    if (!root || typeof root !== 'string') {
      throw new TypeError('AgentHome: root must be a non-empty string');
    }
    this.root = root;
  }

  /**
   * Unified sessions directory. Per AGENTS.md §Session:
   * ```
   * sessions/
   *   └── <sessionId>/
   *       ├── messages.json   (FileSessionStore — LLM context)
   *       └── events.jsonl    (FileEventLogStore — append-only audit log)
   * ```
   * Both the session store and event log share this directory,
   * each session living in its own subdirectory.
   */
  get sessionsDir(): string {
    return join(this.root, 'sessions');
  }

  /**
   * Agent-local skill pool. Scanned one level deep by the SDK's skill
   * loader. Products can expose additional global pools via the agent
   * config's `skillDirs` — they are not a substitute for this one.
   */
  get skillsDir(): string {
    return join(this.root, 'skills');
  }

  /**
   * Agent-local MCP config. The SDK does not own the MCP loader (that
   * lives in the product / @berry-agent/mcp), but it does vend the path
   * so every consumer agrees on the filename and location.
   */
  get mcpConfigPath(): string {
    return join(this.root, '.mcp.json');
  }

  /** `FileAgentMemory` target — the agent's long-term memory index. */
  get memoryPath(): string {
    return join(this.root, 'MEMORY.md');
  }

  /** `AGENTS.md` — the agent-authored system-prompt snippet. */
  get agentMdPath(): string {
    return join(this.root, 'AGENTS.md');
  }

  /** `agent.json` — workspace initializer writes `{id, name, createdAt}` here. */
  get metadataPath(): string {
    return join(this.root, 'agent.json');
  }

  /**
   * Create the directory tree. Idempotent. Only creates directories that
   * need to exist before first write; leaf files (AGENTS.md, MEMORY.md,
   * agent.json) are created lazily by their respective owners or by
   * `initWorkspace()`.
   */
  async ensure(): Promise<void> {
    await mkdir(this.sessionsDir, { recursive: true });
    await mkdir(this.skillsDir, { recursive: true });
  }

  /**
   * Structured snapshot for facts / diagnostic APIs. Intentionally
   * includes only paths — no I/O state — so it's safe to serialize.
   */
  toSnapshot(): AgentHomeSnapshot {
    return {
      root: this.root,
      sessionsDir: this.sessionsDir,
      skillsDir: this.skillsDir,
      mcpConfigPath: this.mcpConfigPath,
      memoryPath: this.memoryPath,
      agentMdPath: this.agentMdPath,
      metadataPath: this.metadataPath,
    };
  }
}

export interface AgentHomeSnapshot {
  root: string;
  sessionsDir: string;
  skillsDir: string;
  mcpConfigPath: string;
  memoryPath: string;
  agentMdPath: string;
  metadataPath: string;
}
