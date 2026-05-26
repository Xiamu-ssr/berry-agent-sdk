import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { readFile, realpath, readdir, stat } from 'node:fs/promises';

import type { AgentScope } from '../scope.js';

export type AgentBrowseRootKind = 'project' | 'workspace';

export interface AgentBrowseRoot {
  root: string;
  kind: AgentBrowseRootKind;
}

export interface AgentFileEntry {
  name: string;
  path: string;
  type: 'file' | 'directory';
  size?: number;
  mtimeMs?: number;
}

export interface AgentFileList {
  root: AgentBrowseRoot;
  path: string;
  entries: AgentFileEntry[];
}

export interface AgentFileContent {
  root: AgentBrowseRoot;
  path: string;
  name: string;
  size: number;
  mtimeMs: number;
  content: string;
  truncated: boolean;
}

export interface AgentFileBrowserOptions {
  maxEntries?: number;
  maxReadBytes?: number;
}

const DEFAULT_MAX_ENTRIES = 500;
const DEFAULT_MAX_READ_BYTES = 512 * 1024;

/**
 * Read-only browser over the active agent's project/workspace root.
 *
 * This belongs in core because AgentScope is the permission fact source. Host
 * products can expose the data over REST, native UI, or remote bridges without
 * re-implementing path traversal and symlink checks.
 */
export class AgentFileBrowser {
  private readonly maxEntries: number;
  private readonly maxReadBytes: number;

  constructor(private readonly scope: AgentScope, options: AgentFileBrowserOptions = {}) {
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.maxReadBytes = options.maxReadBytes ?? DEFAULT_MAX_READ_BYTES;
  }

  browseRoot(): AgentBrowseRoot {
    return this.scope.project
      ? { root: this.scope.project, kind: 'project' }
      : { root: this.scope.workspace, kind: 'workspace' };
  }

  async list(requestPath = ''): Promise<AgentFileList> {
    const root = this.browseRoot();
    const { absolute, relativePath } = await this.resolvePath(root, requestPath);
    const info = await stat(absolute);
    if (!info.isDirectory()) throw new Error(`Not a directory: ${relativePath || '.'}`);

    const entries = await readdir(absolute, { withFileTypes: true });
    const items: AgentFileEntry[] = [];
    for (const entry of entries.slice(0, this.maxEntries)) {
      if (!entry.isDirectory() && !entry.isFile()) continue;
      let childStat: Awaited<ReturnType<typeof stat>>;
      try {
        childStat = await stat(join(absolute, entry.name));
      } catch {
        continue;
      }
      items.push({
        name: entry.name,
        path: normalizeBrowsePath(join(relativePath, entry.name)),
        type: entry.isDirectory() ? 'directory' : 'file',
        ...(entry.isFile() ? { size: childStat.size } : {}),
        mtimeMs: childStat.mtimeMs,
      });
    }

    items.sort((a, b) =>
      a.type === b.type
        ? a.name.localeCompare(b.name)
        : a.type === 'directory' ? -1 : 1,
    );
    return { root, path: relativePath, entries: items };
  }

  async read(requestPath: string): Promise<AgentFileContent> {
    const root = this.browseRoot();
    const { absolute, relativePath } = await this.resolvePath(root, requestPath);
    const info = await stat(absolute);
    if (!info.isFile()) throw new Error(`Not a file: ${relativePath || '.'}`);

    const raw = await readFile(absolute);
    const truncated = raw.byteLength > this.maxReadBytes;
    const slice = truncated ? raw.subarray(0, this.maxReadBytes) : raw;
    return {
      root,
      path: relativePath,
      name: basename(absolute),
      size: info.size,
      mtimeMs: info.mtimeMs,
      content: slice.toString('utf-8'),
      truncated,
    };
  }

  private async resolvePath(root: AgentBrowseRoot, requestPath: string): Promise<{ absolute: string; relativePath: string }> {
    const rootReal = await realpath(root.root);
    const normalizedRequest = normalizeBrowsePath(requestPath);
    const target = resolve(rootReal, normalizedRequest || '.');
    const targetReal = await realpath(target);
    const rel = relative(rootReal, targetReal);
    if (rel === '..' || rel.startsWith('../') || rel.startsWith('..\\') || isAbsolute(rel)) {
      throw new Error('Path escapes agent browse root');
    }
    return {
      absolute: targetReal,
      relativePath: normalizeBrowsePath(rel),
    };
  }
}

export function createAgentFileBrowser(scope: AgentScope, options?: AgentFileBrowserOptions): AgentFileBrowser {
  return new AgentFileBrowser(scope, options);
}

export function normalizeBrowsePath(value: string): string {
  return value
    .replace(/\\/g, '/')
    .split('/')
    .filter((part) => part && part !== '.')
    .join('/');
}
