// ============================================================
// @berry-agent/memory-file — Session history semantic provider
// ============================================================
//
// L3 memory: keyword-searchable index over the agent's full
// conversation history (events.jsonl across all sessions). Reuses
// the existing FTS5 ChunkStore so the on-disk layout, search ranking,
// and dispose semantics are identical to FileMemoryProvider.
//
// Why this exists separate from FileMemoryProvider:
//   - Different content type (live event stream vs static markdown).
//   - Different update model (subscribes to event log appends; never
//     full-rescans the file because events.jsonl is append-only and
//     can be MB-sized).
//   - Different result framing — search hits cite session+event ids
//     rather than file paths so consumers can deep-link in a UI.
//
// What gets indexed: user_message + assistant_message events, with
// the message text chunked the same way markdown is (paragraph-ish
// chunks). Tool calls/results stay out — they're verbose and rarely
// the answer to "what did the user say last week about X?".

import path from 'node:path';
import { errorMessage, type EventLogListener, type SessionEvent, type ToolRegistration } from '@berry-agent/core';
import { chunkMarkdown } from './chunker.js';
import { hashText } from './hash.js';
import { ChunkStore, type SearchHit } from './store.js';

export interface SessionHistoryProviderOptions {
  /** Where the sqlite index lives. Defaults to `<workspaceDir>/.berry/session-history.sqlite`. */
  indexPath?: string;
  /** Workspace root — used to derive the default indexPath. */
  workspaceDir: string;
  /** Default max results per search call. */
  maxResults?: number;
  /** Default min score (normalized 0..1). */
  minScore?: number;
  /** Override chunking. Defaults to 400/80 tokens — same as memory-file. */
  chunking?: { tokens?: number; overlap?: number };
}

const DEFAULT_MAX_RESULTS = 6;
const DEFAULT_MIN_SCORE = 0.1;
const DEFAULT_CHUNK_TOKENS = 400;
const DEFAULT_CHUNK_OVERLAP = 80;

/** Surface shown to callers of the search tool — distinct from MemorySearchResult. */
export interface SessionHistorySearchResult {
  /** Stable chunk id (sha1 of session+event+chunk). */
  id: string;
  /** Session id the message originated in. */
  sessionId: string;
  /** Event id the message originated from. */
  eventId: string;
  /** 'user' | 'assistant'. */
  role: 'user' | 'assistant';
  /** Unix ms at which the message was recorded. */
  timestamp: number;
  /** Snippet, with FTS5 <mark>..</mark> highlighting. */
  snippet: string;
  /** Normalized score (0..1, higher = better). */
  score: number;
}

export interface SessionHistoryProvider {
  readonly id: 'session-history';
  /** Subscribe to live event appends so the index stays current. Returns the unsubscribe fn. */
  attach(subscribe: (listener: EventLogListener) => () => void): () => void;
  /** Index a single event right now. Idempotent on chunk id. */
  ingest(sessionId: string, event: SessionEvent): void;
  /** Run a query directly (for tests / bypass). */
  search(query: string, options?: { maxResults?: number; minScore?: number }): SessionHistorySearchResult[];
  /** Tool registrations to mount on the Agent. */
  tools(): ToolRegistration[];
  /** Release sqlite handle. */
  dispose(): void;
}

export function createSessionHistoryProvider(options: SessionHistoryProviderOptions): SessionHistoryProvider {
  const indexPath = options.indexPath ?? path.join(options.workspaceDir, '.berry', 'session-history.sqlite');
  const store = new ChunkStore(indexPath);
  const maxResults = options.maxResults ?? DEFAULT_MAX_RESULTS;
  const minScore = options.minScore ?? DEFAULT_MIN_SCORE;
  const chunkOpts = {
    tokens: options.chunking?.tokens ?? DEFAULT_CHUNK_TOKENS,
    overlap: options.chunking?.overlap ?? DEFAULT_CHUNK_OVERLAP,
  };
  const unsubscribers = new Set<() => void>();

  const ingest: SessionHistoryProvider['ingest'] = (sessionId, event) => {
    if (event.type !== 'user_message' && event.type !== 'assistant_message') return;
    const text = renderMessageText(event);
    if (!text || text.trim().length === 0) return;
    const chunks = chunkMarkdown(text, chunkOpts);
    if (chunks.length === 0) return;
    const filePath = `session:${sessionId}/${event.id}`;
    store.replaceFile({
      filePath,
      mtime: event.timestamp,
      chunks,
      idFor: (chunk) => hashText(`${filePath}:${chunk.startLine}:${chunk.text}`),
    });
  };

  return {
    id: 'session-history',
    attach(subscribe) {
      const unsub = subscribe((sessionId, event) => ingest(sessionId, event));
      unsubscribers.add(unsub);
      return unsub;
    },
    ingest,
    search(query, opts) {
      const maxR = opts?.maxResults ?? maxResults;
      const minS = opts?.minScore ?? minScore;
      const hits = store.search(query, maxR);
      return hits
        .map((hit) => toResult(hit))
        .filter((r) => r.score >= minS);
    },
    tools(): ToolRegistration[] {
      return [
        {
          definition: {
            name: 'search_session_history',
            description:
              'Search across this agent\'s past conversations (events.jsonl) for messages whose text matches the query. Returns ranked snippets with session id, event id, role, and timestamp. Use when the user says "what did we discuss" / "did I mention X" / "earlier you said" — anything requiring recall outside the current context window. Returns at most maxResults snippets, sorted by relevance.',
            inputSchema: {
              type: 'object',
              properties: {
                query: { type: 'string', description: 'Free-form search text. Quote phrases for exact match.' },
                maxResults: { type: 'number', description: 'Max snippets to return. Default 6.' },
              },
              required: ['query'],
            },
          },
          execute: async (input) => {
            const query = String(input.query ?? '').trim();
            if (!query) return { content: 'query is required', isError: true };
            try {
              const results = this.search(query, {
                maxResults: typeof input.maxResults === 'number' ? input.maxResults : undefined,
              });
              if (results.length === 0) {
                return { content: `No session history matches "${query}".` };
              }
              const rendered = results.map(formatResult).join('\n\n---\n\n');
              return { content: rendered };
            } catch (err) {
              return { content: `search_session_history failed: ${errorMessage(err)}`, isError: true };
            }
          },
        },
      ];
    },
    dispose() {
      for (const u of unsubscribers) {
        try { u(); } catch { /* ignore */ }
      }
      unsubscribers.clear();
      store.close();
    },
  };
}

function renderMessageText(event: SessionEvent): string {
  // user_message and assistant_message carry `content` which is either a
  // string or ContentBlock[]. We render text blocks only — tool_use blocks
  // get summarised so we don't pollute the FTS index with JSON.
  if (event.type === 'user_message') {
    if (typeof event.content === 'string') return event.content;
    return event.content
      .map((b) => {
        if (b.type === 'text') return b.text;
        if (b.type === 'image') return '[image]';
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  if (event.type === 'assistant_message') {
    return event.content
      .map((b) => {
        if (b.type === 'text') return b.text;
        if (b.type === 'thinking') return ''; // exclude reasoning from history search
        if (b.type === 'tool_use') return `[called ${b.name}]`;
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

function toResult(hit: SearchHit): SessionHistorySearchResult {
  // Parse the synthetic file path back into session + event ids.
  // Format: session:<sessionId>/<eventId>
  const match = /^session:([^/]+)\/(.+)$/.exec(hit.path);
  const sessionId = match?.[1] ?? '';
  const eventId = match?.[2] ?? '';
  return {
    id: hit.id,
    sessionId,
    eventId,
    role: 'user', // we don't track role per chunk — caller can look up event by id
    timestamp: 0,
    snippet: hit.snippet,
    score: Math.max(0, Math.min(1, 1 - hit.bm25 / 10)), // crude normalisation
  };
}

function formatResult(r: SessionHistorySearchResult): string {
  return `[score=${r.score.toFixed(3)}] session=${r.sessionId} event=${r.eventId}\n${r.snippet}`;
}
