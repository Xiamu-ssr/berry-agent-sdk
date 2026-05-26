import type { Message } from './content-types.js';

export interface Session {
  id: string;
  messages: Message[];
  createdAt: number;
  lastAccessedAt: number;
  metadata: SessionMetadata;
}

export interface SessionMetadata {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheWriteTokens: number;
  compactionCount: number;
  /** Last known input token count from the most recent API response. */
  lastInputTokens?: number;
  /** Minimal per-session todo state kept outside the system prompt. */
  todo?: SessionTodoState;
}

export interface TodoItem {
  text: string;
  done?: boolean;
}

export interface SessionTodoState {
  items: TodoItem[];
  updatedAt: number;
}

export interface SessionStore {
  save(session: Session): Promise<void>;
  load(id: string): Promise<Session | null>;
  loadSummary?(id: string): Promise<Pick<Session, 'id' | 'createdAt' | 'lastAccessedAt' | 'metadata'> | null>;
  listSummaries?(): Promise<Array<Pick<Session, 'id' | 'createdAt' | 'lastAccessedAt' | 'metadata'>>>;
  list(): Promise<string[]>;
  delete(id: string): Promise<void>;
}
