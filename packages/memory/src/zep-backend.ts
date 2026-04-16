// ============================================================
// Berry Agent SDK — Zep Memory Backend
// ============================================================
// Adapter for Zep (https://getzep.com) long-term memory service.
// Uses Zep's memory API for semantic search over conversations.
//
// Requires: Zep server/cloud + API key.
// This is a thin HTTP adapter — no Zep SDK dependency.

import type { AgentMemory } from '@berry-agent/core';
import type {
  MemoryBackend,
  MemoryEntry,
  MemorySearchOptions,
  MemoryListOptions,
  ZepConfig,
} from './types.js';

/**
 * Zep-backed MemoryBackend.
 *
 * Maps Berry memory operations to Zep Graph Memory API (v2):
 *   add()    → POST /api/v2/users/{userId}/memory
 *   search() → POST /api/v2/users/{userId}/memory/search
 *   get()    → GET  /api/v2/users/{userId}/memory/{id} (via search by id)
 */
export class ZepMemoryBackend implements MemoryBackend {
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;
  private readonly collection: string;

  constructor(config: ZepConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.headers = {
      'Content-Type': 'application/json',
      'Authorization': `Api-Key ${config.apiKey}`,
    };
    this.collection = config.collection;
  }

  async add(content: string, metadata?: Record<string, unknown>): Promise<string> {
    const body = {
      messages: [{ role_type: 'user', content, metadata }],
    };

    const res = await fetch(`${this.baseUrl}/api/v2/users/${this.collection}/memory`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Zep add failed: ${res.status} ${await res.text()}`);
    // Zep doesn't return entry ID from message add — generate a local one
    const data = await res.json() as Record<string, unknown>;
    return String(data.uuid ?? `zep_${Date.now()}`);
  }

  async get(id: string): Promise<MemoryEntry | null> {
    // Zep doesn't have direct get-by-id for facts; search with id filter
    const entries = await this.search(id, { limit: 1 });
    return entries[0] ?? null;
  }

  async update(id: string, content: string): Promise<void> {
    // Zep graph memory doesn't support direct fact updates
    // Workaround: delete and re-add
    await this.delete(id);
    await this.add(content);
  }

  async delete(id: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/api/v2/users/${this.collection}/memory/${id}`, {
      method: 'DELETE',
      headers: this.headers,
    });
    if (!res.ok && res.status !== 404) throw new Error(`Zep delete failed: ${res.status}`);
  }

  async search(query: string, options?: MemorySearchOptions): Promise<MemoryEntry[]> {
    const body: Record<string, unknown> = {
      text: query,
      limit: options?.limit ?? 10,
      min_score: options?.minScore,
      search_type: 'similarity',
    };

    const res = await fetch(`${this.baseUrl}/api/v2/users/${this.collection}/memory/search`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Zep search failed: ${res.status}`);
    const data = await res.json() as { results?: Array<Record<string, unknown>> };
    return (data.results ?? []).map(r => this.toEntry(r));
  }

  async list(options?: MemoryListOptions): Promise<MemoryEntry[]> {
    const params = new URLSearchParams();
    if (options?.limit) params.set('limit', String(options.limit));

    const res = await fetch(`${this.baseUrl}/api/v2/users/${this.collection}/memory?${params}`, {
      headers: this.headers,
    });
    if (!res.ok) throw new Error(`Zep list failed: ${res.status}`);
    const data = await res.json() as { facts?: Array<Record<string, unknown>> };
    return (data.facts ?? []).map(r => this.toEntry(r));
  }

  async clear(): Promise<void> {
    const res = await fetch(`${this.baseUrl}/api/v2/users/${this.collection}/memory`, {
      method: 'DELETE',
      headers: this.headers,
    });
    if (!res.ok) throw new Error(`Zep clear failed: ${res.status}`);
  }

  async count(): Promise<number> {
    const entries = await this.list({ limit: 1000 });
    return entries.length;
  }

  asAgentMemory(): AgentMemory {
    return {
      load: async () => {
        const entries = await this.list({ limit: 100 });
        return entries.map(e => e.content).join('\n\n');
      },
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

  // ----- Internal -----

  private toEntry(raw: Record<string, unknown>): MemoryEntry {
    return {
      id: String(raw.uuid ?? raw.id ?? ''),
      content: String(raw.fact ?? raw.content ?? raw.text ?? ''),
      metadata: (raw.metadata as Record<string, unknown>) ?? undefined,
      createdAt: raw.created_at ? new Date(String(raw.created_at)).getTime() : Date.now(),
      updatedAt: raw.updated_at ? new Date(String(raw.updated_at)).getTime() : undefined,
      score: typeof raw.score === 'number' ? raw.score : undefined,
    };
  }
}
