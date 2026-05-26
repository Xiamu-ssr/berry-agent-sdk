// ============================================================
// Agent helpers — session utilities
// ============================================================
// Pure helpers for constructing / normalizing session state.

import type { Session, SessionMetadata, SessionStore } from '../session-types.js';

/** Volatile, single-process session store used when no store is configured. */
export function createInMemoryStore(): SessionStore {
  const sessions = new Map<string, Session>();
  return {
    save: async (s) => { sessions.set(s.id, structuredClone(s)); },
    load: async (id) => {
      const s = sessions.get(id);
      return s ? structuredClone(s) : null;
    },
    list: async () => [...sessions.keys()],
    delete: async (id) => { sessions.delete(id); },
  };
}

export function createEmptySessionMetadata(): SessionMetadata {
  return {
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheWriteTokens: 0,
    compactionCount: 0,
  };
}

export function normalizeLoadedSession(session: Session | null): Session | null {
  return session;
}
