// ============================================================
// Berry Agent SDK — File-based Memory Backend
// ============================================================
// Stores memories as JSON entries in a local directory.
// Search is basic substring matching (no vectors).
// Good for: local dev, single-agent, low volume.

import { readFile, writeFile, readdir, unlink, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AgentMemory } from '@berry-agent/core';
import type {
  MemoryBackend,
  MemoryEntry,
  MemorySearchOptions,
  MemoryListOptions,
  FileMemoryConfig,
} from './types.js';

/**
 * File-based MemoryBackend.
 *
 * Storage layout:
 *   {dir}/entries/       — one JSON file per entry (UUID.json)
 *   {dir}/MEMORY.md      — AgentMemory-compatible markdown view
 *
 * Search: case-insensitive substring matching with simple tf-idf-ish scoring.
 */
export class FileMemoryBackend implements MemoryBackend {
  private readonly entriesDir: string;
  private readonly memoryMdPath: string;
  private initialized = false;

  constructor(private readonly config: FileMemoryConfig) {
    this.entriesDir = join(config.dir, 'entries');
    this.memoryMdPath = join(config.dir, 'MEMORY.md');
  }

  private async ensureDir(): Promise<void> {
    if (this.initialized) return;
    await mkdir(this.entriesDir, { recursive: true });
    this.initialized = true;
  }

  private entryPath(id: string): string {
    return join(this.entriesDir, `${id}.json`);
  }

  // ----- MemoryBackend CRUD -----

  async add(content: string, metadata?: Record<string, unknown>): Promise<string> {
    await this.ensureDir();
    const id = randomUUID();
    const entry: MemoryEntry = {
      id,
      content,
      metadata,
      createdAt: Date.now(),
    };
    await writeFile(this.entryPath(id), JSON.stringify(entry, null, 2), 'utf-8');
    await this.rebuildMarkdown();
    return id;
  }

  async get(id: string): Promise<MemoryEntry | null> {
    try {
      const raw = await readFile(this.entryPath(id), 'utf-8');
      return JSON.parse(raw) as MemoryEntry;
    } catch {
      return null;
    }
  }

  async update(id: string, content: string, metadata?: Record<string, unknown>): Promise<void> {
    const existing = await this.get(id);
    if (!existing) throw new Error(`Memory entry not found: ${id}`);
    const updated: MemoryEntry = {
      ...existing,
      content,
      metadata: metadata ?? existing.metadata,
      updatedAt: Date.now(),
    };
    await writeFile(this.entryPath(id), JSON.stringify(updated, null, 2), 'utf-8');
    await this.rebuildMarkdown();
  }

  async delete(id: string): Promise<void> {
    try {
      await unlink(this.entryPath(id));
    } catch {
      // Already gone
    }
    await this.rebuildMarkdown();
  }

  // ----- Search (substring matching) -----

  async search(query: string, options?: MemorySearchOptions): Promise<MemoryEntry[]> {
    const all = await this.loadAllEntries();
    const q = query.toLowerCase();
    const terms = q.split(/\s+/).filter(Boolean);
    const limit = options?.limit ?? 10;

    const scored: MemoryEntry[] = [];
    for (const entry of all) {
      const text = entry.content.toLowerCase();

      // Check metadata filter
      if (options?.filter) {
        let match = true;
        for (const [k, v] of Object.entries(options.filter)) {
          if (entry.metadata?.[k] !== v) { match = false; break; }
        }
        if (!match) continue;
      }

      // Score: fraction of query terms that appear in the content
      let hits = 0;
      for (const term of terms) {
        if (text.includes(term)) hits++;
      }
      if (hits === 0) continue;
      const score = hits / terms.length;

      if (options?.minScore && score < options.minScore) continue;
      scored.push({ ...entry, score });
    }

    // Sort by score desc, then by recency
    scored.sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || b.createdAt - a.createdAt);
    return scored.slice(0, limit);
  }

  // ----- List / Clear / Count -----

  async list(options?: MemoryListOptions): Promise<MemoryEntry[]> {
    const all = await this.loadAllEntries();
    const order = options?.order ?? 'desc';
    all.sort((a, b) => order === 'desc' ? b.createdAt - a.createdAt : a.createdAt - b.createdAt);
    const offset = options?.offset ?? 0;
    const limit = options?.limit ?? 100;
    return all.slice(offset, offset + limit);
  }

  async clear(): Promise<void> {
    await this.ensureDir();
    const files = await this.listEntryFiles();
    await Promise.all(files.map(f => unlink(join(this.entriesDir, f))));
    await writeFile(this.memoryMdPath, '# Agent Memory\n\n_No entries._\n', 'utf-8');
  }

  async count(): Promise<number> {
    const files = await this.listEntryFiles();
    return files.length;
  }

  // ----- AgentMemory bridge -----

  asAgentMemory(): AgentMemory {
    return {
      load: () => this.loadMarkdown(),
      append: async (content: string) => {
        await this.add(content);
      },
      write: async (content: string) => {
        await this.clear();
        await this.add(content);
      },
      exists: async () => (await this.count()) > 0,
    };
  }

  // ----- Internal helpers -----

  private async loadAllEntries(): Promise<MemoryEntry[]> {
    await this.ensureDir();
    const files = await this.listEntryFiles();
    const entries: MemoryEntry[] = [];
    for (const file of files) {
      try {
        const raw = await readFile(join(this.entriesDir, file), 'utf-8');
        entries.push(JSON.parse(raw) as MemoryEntry);
      } catch {
        // Skip corrupt files
      }
    }
    return entries;
  }

  private async listEntryFiles(): Promise<string[]> {
    try {
      const files = await readdir(this.entriesDir);
      return files.filter(f => f.endsWith('.json'));
    } catch {
      return [];
    }
  }

  private async loadMarkdown(): Promise<string> {
    try {
      return await readFile(this.memoryMdPath, 'utf-8');
    } catch {
      return '';
    }
  }

  private async rebuildMarkdown(): Promise<void> {
    const entries = await this.loadAllEntries();
    entries.sort((a, b) => a.createdAt - b.createdAt);
    const lines = ['# Agent Memory\n'];
    for (const entry of entries) {
      const ts = new Date(entry.createdAt).toISOString();
      lines.push(`## ${ts}\n`);
      lines.push(entry.content);
      lines.push('');
    }
    await writeFile(this.memoryMdPath, lines.join('\n'), 'utf-8');
  }
}
