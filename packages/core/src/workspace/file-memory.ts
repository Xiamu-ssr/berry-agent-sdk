// ============================================================
// Berry Agent SDK — File-based Agent Memory
// ============================================================

import { readFile, writeFile, appendFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentMemory, MemorySearchResult } from './types.js';

/**
 * File-based AgentMemory backed by `{workspace}/MEMORY.md`.
 * - `load()` returns full content or empty string.
 * - `append()` adds content with a timestamp header.
 * - `write()` replaces the entire file.
 * - `search()` performs a simple case-insensitive substring search over entries.
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

  async search(query: string, options?: { limit?: number }): Promise<MemorySearchResult[]> {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) return [];

    const content = await this.load();
    if (!content.trim()) return [];

    const limit = normalizeLimit(options?.limit);
    const sections = splitMemorySections(content);
    const matches = sections
      .map((section) => {
        const score = countMatches(section.content.toLowerCase(), normalizedQuery);
        if (score === 0) return null;
        return { ...section, score };
      })
      .filter((section): section is MemorySearchResult & { score: number } => section !== null)
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return (b.createdAt ?? 0) - (a.createdAt ?? 0);
      });

    return matches.slice(0, limit);
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

function normalizeLimit(limit?: number): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit)) return 5;
  return Math.max(1, Math.trunc(limit));
}

function splitMemorySections(content: string): MemorySearchResult[] {
  const body = content.replace(/^# Agent Memory\s*/m, '').trim();
  if (!body) return [];

  const sections = body.includes('\n## ')
    ? body.split(/\n(?=## )/g)
    : [body];

  const results: MemorySearchResult[] = [];
  for (const section of sections) {
    const trimmed = section.trim();
    if (!trimmed) continue;

    const [, timestamp] = /^##\s+([^\n]+)\n?/.exec(trimmed) ?? [];
    const createdAt = timestamp ? Date.parse(timestamp) : Number.NaN;
    const result: MemorySearchResult = { content: trimmed };

    if (!Number.isNaN(createdAt)) {
      result.createdAt = createdAt;
    }

    results.push(result);
  }

  return results;
}

function countMatches(haystack: string, needle: string): number {
  let count = 0;
  let index = 0;

  while (index < haystack.length) {
    const next = haystack.indexOf(needle, index);
    if (next === -1) break;
    count++;
    index = next + needle.length;
  }

  return count;
}
