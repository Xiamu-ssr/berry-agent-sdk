// ============================================================
// Berry Agent SDK — File-based Agent Memory
// ============================================================

import { readFile, writeFile, appendFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentMemory } from './types.js';

/**
 * File-based AgentMemory backed by `{workspace}/MEMORY.md`.
 * - `load()` returns full content or empty string.
 * - `append()` adds content with a timestamp header.
 * - `write()` replaces the entire file.
 */
export class FileAgentMemory implements AgentMemory {
  private readonly memoryPath: string;

  constructor(workspaceRoot: string) {
    this.memoryPath = join(workspaceRoot, 'MEMORY.md');
  }

  async load(): Promise<string> {
    try {
      return await readFile(this.memoryPath, 'utf-8');
    } catch (err: unknown) {
      if (isNotFound(err)) return '';
      throw err;
    }
  }

  async append(content: string): Promise<void> {
    const header = `\n## ${new Date().toISOString()}\n\n`;
    await appendFile(this.memoryPath, header + content + '\n', 'utf-8');
  }

  async write(content: string): Promise<void> {
    await writeFile(this.memoryPath, content, 'utf-8');
  }

  async exists(): Promise<boolean> {
    try {
      await access(this.memoryPath);
      return true;
    } catch {
      return false;
    }
  }
}

function isNotFound(err: unknown): boolean {
  return err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT';
}
