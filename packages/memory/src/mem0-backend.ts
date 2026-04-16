// ============================================================
// Berry Agent SDK — mem0 Memory Backend
// ============================================================
// Adapter for mem0 (https://mem0.ai) managed memory service.
// Provides vector-based semantic search via mem0's API.
//
// Requires: mem0 API key + running mem0 instance.
// This is a thin HTTP adapter — no mem0 SDK dependency.

import type { AgentMemory } from '@berry-agent/core';
import type {
  MemoryBackend,
  MemoryEntry,
  MemorySearchOptions,
  MemoryListOptions,
  Mem0Config,
} from './types.js';

/**
 * mem0-backed MemoryBackend.
 *
 * Maps Berry memory operations to mem0 REST API:
 *   add()    → POST /v1/memories/
 *   search() → POST /v1/memories/search/
 *   get()    → GET  /v1/memories/{id}/
 *   delete() → DELETE /v1/memories/{id}/
 *   list()   → GET  /v1/memories/
 */
export class Mem0MemoryBackend implements MemoryBackend {
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;
  private readonly userId?: string;
  private readonly agentId?: string;

  constructor(config: Mem0Config) {
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.headers = {
      'Content-Type': 'application/json',
      'Authorization': `Token ${config.apiKey}`,
    };
    this.userId = config.userId;
    this.agentId = config.agentId;
  }

  async add(content: string, metadata?: Record<string, unknown>): Promise<string> {
    const body: Record<string, unknown> = {
      messages: [{ role: 'user', content }],
      metadata,
    };
    if (this.userId) body.user_id = this.userId;
    if (this.agentId) body.agent_id = this.agentId;

    const res = await fetch(`${this.baseUrl}/v1/memories/`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`mem0 add failed: ${res.status} ${await res.text()}`);
    const data = await res.json() as { results?: Array<{ id: string }> };
    return data.results?.[0]?.id ?? 'unknown';
  }

  async get(id: string): Promise<MemoryEntry | null> {
    const res = await fetch(`${this.baseUrl}/v1/memories/${id}/`, {
      headers: this.headers,
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`mem0 get failed: ${res.status}`);
    const data = await res.json() as Record<string, unknown>;
    return this.toEntry(data);
  }

  async update(id: string, content: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/v1/memories/${id}/`, {
      method: 'PUT',
      headers: this.headers,
      body: JSON.stringify({ text: content }),
    });
    if (!res.ok) throw new Error(`mem0 update failed: ${res.status}`);
  }

  async delete(id: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/v1/memories/${id}/`, {
      method: 'DELETE',
      headers: this.headers,
    });
    if (!res.ok && res.status !== 404) throw new Error(`mem0 delete failed: ${res.status}`);
  }

  async search(query: string, options?: MemorySearchOptions): Promise<MemoryEntry[]> {
    const body: Record<string, unknown> = {
      query,
      limit: options?.limit ?? 10,
    };
    if (this.userId) body.user_id = this.userId;
    if (this.agentId) body.agent_id = this.agentId;
    if (options?.filter) body.filters = options.filter;

    const res = await fetch(`${this.baseUrl}/v1/memories/search/`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`mem0 search failed: ${res.status}`);
    const data = await res.json() as { results?: Array<Record<string, unknown>> };
    return (data.results ?? []).map(r => this.toEntry(r));
  }

  async list(options?: MemoryListOptions): Promise<MemoryEntry[]> {
    const params = new URLSearchParams();
    if (this.userId) params.set('user_id', this.userId);
    if (this.agentId) params.set('agent_id', this.agentId);
    if (options?.limit) params.set('page_size', String(options.limit));

    const res = await fetch(`${this.baseUrl}/v1/memories/?${params}`, {
      headers: this.headers,
    });
    if (!res.ok) throw new Error(`mem0 list failed: ${res.status}`);
    const data = await res.json() as { results?: Array<Record<string, unknown>> };
    return (data.results ?? []).map(r => this.toEntry(r));
  }

  async clear(): Promise<void> {
    const body: Record<string, unknown> = {};
    if (this.userId) body.user_id = this.userId;
    if (this.agentId) body.agent_id = this.agentId;

    const res = await fetch(`${this.baseUrl}/v1/memories/`, {
      method: 'DELETE',
      headers: this.headers,
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`mem0 clear failed: ${res.status}`);
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
      id: String(raw.id ?? ''),
      content: String(raw.memory ?? raw.text ?? raw.content ?? ''),
      metadata: (raw.metadata as Record<string, unknown>) ?? undefined,
      createdAt: raw.created_at ? new Date(String(raw.created_at)).getTime() : Date.now(),
      updatedAt: raw.updated_at ? new Date(String(raw.updated_at)).getTime() : undefined,
      score: typeof raw.score === 'number' ? raw.score : undefined,
    };
  }
}
