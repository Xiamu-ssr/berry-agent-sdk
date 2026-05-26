// ============================================================
// Berry Agent SDK — File-based Project Context
// ============================================================

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { ProjectContext } from './types.js';
import { projectSharedPaths } from './project-layout.js';
export { PROJECT_CONTEXT_FILE } from './project-layout.js';

/**
 * File-based ProjectContext.
 * - `loadContext()` reads the SDK project context file.
 * - `writeContext()` is exposed for human/host editing through SDK APIs.
 */
export class FileProjectContext implements ProjectContext {
  readonly root: string;

  constructor(projectRoot: string) {
    this.root = projectRoot;
  }

  async loadContext(): Promise<string> {
    try {
      return await readFile(projectSharedPaths(this.root).contextPath, 'utf-8');
    } catch (err: unknown) {
      if (isNotFound(err)) return '';
      throw err;
    }
  }

  async writeContext(content: string): Promise<void> {
    const path = projectSharedPaths(this.root).contextPath;
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, 'utf-8');
  }
}

function isNotFound(err: unknown): boolean {
  return err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT';
}
