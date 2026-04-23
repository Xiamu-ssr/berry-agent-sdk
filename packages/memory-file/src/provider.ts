/**
 * File-backed MemoryProvider.
 *
 * Indexes MEMORY.md plus any *.md files under memory/. Exposes:
 *   - memory_search (query-driven excerpt retrieval)
 *   - memory_get    (explicit byte-bounded read of a path)
 *
 * No embedding. No hybrid. FTS5 only in v0.4.0.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { ToolRegistration } from '@berry-agent/core';
import { chunkMarkdown } from './chunker.js';
import { hashText } from './hash.js';
import { ChunkStore, type SearchHit } from './store.js';

export interface FileMemoryProviderOptions {
  /** Workspace root. MEMORY.md and memory/ are looked up here. */
  workspaceDir: string;
  /**
   * Optional project root. When set, the provider also indexes shared
   * knowledge files (`AGENTS.md`, `PROJECT.md`, `.berry-discoveries.md`)
   * under this directory. Results surface with paths prefixed `project/`
   * so consumers can distinguish them from personal memory. Intended use
   * case: teammates searching for shared team knowledge.
   */
  projectDir?: string;
  /** Where the sqlite index lives. Defaults to `<workspaceDir>/.berry/memory.sqlite`. */
  indexPath?: string;
  /** Override chunking. Defaults match OpenClaw (400 / 80). */
  chunking?: { tokens?: number; overlap?: number };
  /** Default max results per memory_search call. */
  maxResults?: number;
  /** Default min score (normalized 0..1) to keep a result. */
  minScore?: number;
}

/** Virtual prefix for project-rooted files in the index. */
const PROJECT_PREFIX = 'project/';

const DEFAULT_CHUNK_TOKENS = 400;
const DEFAULT_CHUNK_OVERLAP = 80;
const DEFAULT_MAX_RESULTS = 6;
const DEFAULT_MIN_SCORE = 0.1; // pure-FTS uses a lower threshold than hybrid 0.35

export interface FileMemoryProvider {
  readonly id: 'memory-file';
  /** Build or refresh the index. Safe to call repeatedly. */
  sync(): Promise<void>;
  /** Run a memory search directly (for tests / consumers bypassing tools). */
  search(query: string, options?: { maxResults?: number; minScore?: number }): Promise<MemorySearchResult[]>;
  /** Read an excerpt from an indexed file. */
  get(params: { path: string; from?: number; lines?: number }): Promise<MemoryGetResult>;
  /** Tool registrations to mount on the Agent. */
  tools(): ToolRegistration[];
  /** Release sqlite handle. */
  dispose(): void;
}

export interface MemorySearchResult {
  id: string;
  path: string;
  startLine: number;
  endLine: number;
  score: number;
  textScore: number;
  snippet: string;
  source: 'memory';
  citation: string;
}

export interface MemoryGetResult {
  path: string;
  from: number;
  to: number;
  text: string;
  truncated: boolean;
}

export function createFileMemoryProvider(options: FileMemoryProviderOptions): FileMemoryProvider {
  const workspaceDir = path.resolve(options.workspaceDir);
  const projectDir = options.projectDir ? path.resolve(options.projectDir) : undefined;
  const indexPath = options.indexPath
    ? path.resolve(options.indexPath)
    : path.join(workspaceDir, '.berry', 'memory.sqlite');
  const chunking = {
    tokens: options.chunking?.tokens ?? DEFAULT_CHUNK_TOKENS,
    overlap: options.chunking?.overlap ?? DEFAULT_CHUNK_OVERLAP,
  };
  const defaultMaxResults = options.maxResults ?? DEFAULT_MAX_RESULTS;
  const defaultMinScore = options.minScore ?? DEFAULT_MIN_SCORE;

  const store = new ChunkStore(indexPath);

  /** Resolve a relative (possibly project-prefixed) path to an absolute file. */
  function resolveRel(rel: string): string {
    if (rel.startsWith(PROJECT_PREFIX)) {
      if (!projectDir) throw new Error('Project path requested but projectDir not configured');
      return path.join(projectDir, rel.slice(PROJECT_PREFIX.length));
    }
    return path.join(workspaceDir, rel);
  }

  async function sync(): Promise<void> {
    const files = listMemoryFiles(workspaceDir, projectDir);
    const seen = new Set<string>();

    for (const rel of files) {
      const abs = resolveRel(rel);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(abs);
      } catch {
        continue;
      }
      const mtime = Math.floor(stat.mtimeMs);
      seen.add(rel);

      const existing = store.getFileMtime(rel);
      if (existing === mtime) continue;

      const raw = fs.readFileSync(abs, 'utf8');
      const chunks = chunkMarkdown(raw, chunking);
      store.replaceFile({
        filePath: rel,
        mtime,
        chunks,
        idFor: (c) => hashText(`${rel}:${c.startLine}:${c.endLine}:${c.text}`),
      });
    }

    // Garbage-collect files that were indexed but no longer exist.
    for (const entry of store.listIndexedFiles()) {
      if (!seen.has(entry.path)) store.removeFile(entry.path);
    }
  }

  function rawScore(hits: SearchHit[]): Array<SearchHit & { score: number }> {
    if (hits.length === 0) return [];
    // bm25 is lower-is-better; convert to 0..1 where 1 is best in the batch.
    // Note: FTS5's bm25() returns negative numbers for matches (worse match = larger magnitude).
    // We invert sign and normalize against the batch min/max.
    const nums = hits.map((h) => -h.bm25);
    const max = Math.max(...nums);
    const min = Math.min(...nums);
    const span = max - min;
    return hits.map((h, i) => {
      const normalized = span === 0 ? 1 : (nums[i]! - min) / span;
      return { ...h, score: normalized };
    });
  }

  async function search(
    query: string,
    opts?: { maxResults?: number; minScore?: number },
  ): Promise<MemorySearchResult[]> {
    await sync();
    const maxResults = Math.max(1, opts?.maxResults ?? defaultMaxResults);
    const minScore = opts?.minScore ?? defaultMinScore;

    // Over-fetch by 3x to give us room after minScore filtering.
    const raw = store.search(query, maxResults * 3);
    const scored = rawScore(raw).filter((r) => r.score >= minScore);
    return scored.slice(0, maxResults).map((r) => ({
      id: r.id,
      path: r.path,
      startLine: r.startLine,
      endLine: r.endLine,
      score: r.score,
      textScore: r.score, // FTS-only: textScore == score
      snippet: r.snippet,
      source: 'memory',
      citation: `${r.path}#L${r.startLine}-L${r.endLine}`,
    }));
  }

  async function getExcerpt(params: { path: string; from?: number; lines?: number }): Promise<MemoryGetResult> {
    const rel = normalizeRel(params.path);
    const abs = resolveRel(rel);
    const raw = fs.readFileSync(abs, 'utf8');
    const allLines = raw.split('\n');
    const total = allLines.length;
    const from = Math.max(1, params.from ?? 1);
    const defaultWindow = 80;
    const lines = Math.max(1, params.lines ?? defaultWindow);
    const to = Math.min(total, from + lines - 1);
    const excerpt = allLines.slice(from - 1, to).join('\n');
    return {
      path: rel,
      from,
      to,
      text: excerpt,
      truncated: to < total,
    };
  }

  function tools(): ToolRegistration[] {
    return [
      {
        definition: {
          name: 'memory_search',
          description:
            "Semantically search MEMORY.md and memory/*.md for passages relevant to `query`. Returns the top matches with stable citations (path#Lstart-Lend). Use this before answering from what you think you remember.",
          inputSchema: {
            type: 'object',
            properties: {
              query: { type: 'string', description: 'Free-form search query' },
              maxResults: {
                type: 'number',
                description: `Max results to return (default ${defaultMaxResults})`,
              },
              minScore: {
                type: 'number',
                description: `Minimum normalized score in [0,1] (default ${defaultMinScore})`,
              },
            },
            required: ['query'],
          },
        },
        execute: async (input) => {
          const query = String(input.query ?? '');
          if (!query.trim()) {
            return { content: 'Error: query must not be empty', isError: true };
          }
          const maxResults = typeof input.maxResults === 'number' ? input.maxResults : undefined;
          const minScore = typeof input.minScore === 'number' ? input.minScore : undefined;
          const started = Date.now();
          const results = await search(query, { maxResults, minScore });
          return {
            content: JSON.stringify(
              {
                results,
                provider: 'none',
                debug: {
                  backend: 'fts',
                  searchMs: Date.now() - started,
                  hits: results.length,
                },
              },
              null,
              2,
            ),
          };
        },
      },
      {
        definition: {
          name: 'memory_get',
          description:
            'Read an excerpt of MEMORY.md or memory/*.md by path. Use this after memory_search to pull full context for a specific citation.',
          inputSchema: {
            type: 'object',
            properties: {
              path: {
                type: 'string',
                description: 'Workspace-relative path, e.g. "MEMORY.md" or "memory/2026-04-20.md"',
              },
              from: { type: 'number', description: '1-based start line (default 1)' },
              lines: { type: 'number', description: 'Number of lines to return (default 80)' },
            },
            required: ['path'],
          },
        },
        execute: async (input) => {
          const p = String(input.path ?? '');
          if (!p) return { content: 'Error: path is required', isError: true };
          const from = typeof input.from === 'number' ? input.from : undefined;
          const lines = typeof input.lines === 'number' ? input.lines : undefined;
          try {
            const result = await getExcerpt({ path: p, from, lines });
            return { content: JSON.stringify(result, null, 2) };
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            return { content: `Error: ${message}`, isError: true };
          }
        },
      },
    ];
  }

  return {
    id: 'memory-file',
    sync,
    search,
    get: getExcerpt,
    tools,
    dispose: () => store.close(),
  };
}

function listMemoryFiles(workspaceDir: string, projectDir?: string): string[] {
  const results: string[] = [];
  // ----- Personal memory (agent workspace) -----
  const memoryRoot = path.join(workspaceDir, 'MEMORY.md');
  if (fs.existsSync(memoryRoot) && fs.statSync(memoryRoot).isFile()) {
    results.push('MEMORY.md');
  }
  const memoryDir = path.join(workspaceDir, 'memory');
  if (fs.existsSync(memoryDir) && fs.statSync(memoryDir).isDirectory()) {
    for (const entry of fs.readdirSync(memoryDir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith('.md')) continue;
      results.push(path.posix.join('memory', entry.name));
    }
  }
  // ----- Project knowledge (team-shared) -----
  // These files live in the project root, not the workspace. Prefix them
  // with `project/` in the virtual index path so search results make it
  // obvious they're shared, and so consumers can filter by source.
  if (projectDir) {
    for (const name of ['AGENTS.md', 'PROJECT.md', '.berry-discoveries.md']) {
      const abs = path.join(projectDir, name);
      if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
        results.push(PROJECT_PREFIX + name);
      }
    }
  }
  return results;
}

function normalizeRel(p: string): string {
  const clean = p.replace(/\\/g, '/').replace(/^\.\/?/, '');
  if (clean.startsWith('/') || clean.includes('..')) {
    throw new Error(`Invalid memory path: ${p}`);
  }
  return clean;
}
