// ============================================================
// Berry Agent SDK — File-based Project Context
// ============================================================

import { readFile, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ProjectContext } from './types.js';

/** Known project context filenames, checked in order. */
const CONTEXT_FILES = ['AGENTS.md', 'PROJECT.md'] as const;

/**
 * File-based ProjectContext.
 * - `loadContext()` reads the first found of AGENTS.md or PROJECT.md.
 * - `appendDiscovery()` appends to `.berry-discoveries.md`.
 */
export class FileProjectContext implements ProjectContext {
  readonly root: string;

  constructor(projectRoot: string) {
    this.root = projectRoot;
  }

  async loadContext(): Promise<string> {
    for (const filename of CONTEXT_FILES) {
      try {
        return await readFile(join(this.root, filename), 'utf-8');
      } catch (err: unknown) {
        if (isNotFound(err)) continue;
        throw err;
      }
    }
    return '';
  }

  async appendDiscovery(content: string): Promise<void> {
    const header = `\n## ${new Date().toISOString()}\n\n`;
    const discoveriesPath = join(this.root, '.berry-discoveries.md');
    await appendFile(discoveriesPath, header + content + '\n', 'utf-8');
  }
}

function isNotFound(err: unknown): boolean {
  return err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT';
}
