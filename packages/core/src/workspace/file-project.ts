// ============================================================
// Berry Agent SDK — File-based Project Context
// ============================================================

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ProjectContext } from './types.js';

/** The single project-level context file. Humans maintain it; agents read only. */
const CONTEXT_FILE = 'AGENTS.md' as const;

/**
 * File-based ProjectContext.
 * - `loadContext()` reads `{project}/AGENTS.md`.
 * - No write path: project-level knowledge is team-shared and maintained by humans.
 */
export class FileProjectContext implements ProjectContext {
  readonly root: string;

  constructor(projectRoot: string) {
    this.root = projectRoot;
  }

  async loadContext(): Promise<string> {
    try {
      return await readFile(join(this.root, CONTEXT_FILE), 'utf-8');
    } catch (err: unknown) {
      if (isNotFound(err)) return '';
      throw err;
    }
  }
}

function isNotFound(err: unknown): boolean {
  return err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT';
}
