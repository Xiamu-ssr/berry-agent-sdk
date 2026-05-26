// ============================================================
// Agent workspace data access
// ============================================================

import { readFile, writeFile } from 'node:fs/promises';

import type { AgentHome } from '../agent-home.js';
import { PROJECT_CONTEXT_FILE } from '../workspace/file-project.js';
import type { AgentMemory, ProjectContext } from '../workspace/types.js';

export interface AgentWorkspaceDataDeps {
  home: AgentHome;
  memory: () => AgentMemory | undefined;
  projectContext: () => ProjectContext | undefined;
}

/**
 * SDK-owned data access boundary for an Agent workspace.
 *
 * Hosts can expose these methods to humans, but they should not duplicate the
 * directory layout or file conventions outside the SDK.
 */
export class AgentWorkspaceData {
  constructor(private readonly deps: AgentWorkspaceDataDeps) {}

  async readMemory(): Promise<{ path: string; content: string }> {
    return {
      path: this.deps.home.memoryPath,
      content: await this.loadMemory(),
    };
  }

  async writeMemory(content: string): Promise<{ path: string; bytes: number }> {
    const memory = this.requireMemory();
    await memory.write(content);
    return {
      path: this.deps.home.memoryPath,
      bytes: Buffer.byteLength(content, 'utf-8'),
    };
  }

  async readInstructions(): Promise<{ path: string; content: string }> {
    try {
      return {
        path: this.deps.home.agentMdPath,
        content: await readFile(this.deps.home.agentMdPath, 'utf-8'),
      };
    } catch (err: unknown) {
      if (isNotFound(err)) {
        return { path: this.deps.home.agentMdPath, content: '' };
      }
      throw err;
    }
  }

  async writeInstructions(content: string): Promise<{ path: string; bytes: number }> {
    await writeFile(this.deps.home.agentMdPath, content, 'utf-8');
    return {
      path: this.deps.home.agentMdPath,
      bytes: Buffer.byteLength(content, 'utf-8'),
    };
  }

  async readProjectKnowledge(): Promise<{ project: string | null; files: Array<{ path: string; content: string }> }> {
    const projectContext = this.deps.projectContext();
    if (!projectContext) {
      return { project: null, files: [] };
    }
    const content = await projectContext.loadContext();
    return {
      project: projectContext.root,
      files: content.trim().length > 0
        ? [{ path: PROJECT_CONTEXT_FILE, content }]
        : [],
    };
  }

  async writeProjectKnowledge(content: string): Promise<{ project: string; path: string; bytes: number }> {
    const projectContext = this.requireProjectContext();
    await projectContext.writeContext(content);
    return {
      project: projectContext.root,
      path: PROJECT_CONTEXT_FILE,
      bytes: Buffer.byteLength(content, 'utf-8'),
    };
  }

  private async loadMemory(): Promise<string> {
    return this.deps.memory()?.load() ?? '';
  }

  private requireMemory(): AgentMemory {
    const memory = this.deps.memory();
    if (!memory) {
      throw new Error('Agent memory is not available');
    }
    return memory;
  }

  private requireProjectContext(): ProjectContext {
    const projectContext = this.deps.projectContext();
    if (!projectContext) {
      throw new Error('Agent has no project context');
    }
    return projectContext;
  }
}

function isNotFound(err: unknown): boolean {
  return err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT';
}
