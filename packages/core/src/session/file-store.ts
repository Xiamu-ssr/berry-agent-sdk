import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

import type { Message } from '../content-types.js';
import type { Session, SessionMetadata, SessionStore } from '../session-types.js';
import { zContentBlock } from '../schema.js';

// Session is persisted as a directory per id:
//   {rootDir}/{encodedId}/messages.json   — authoritative conversation
//   {rootDir}/{encodedId}/metadata.json   — id, timestamps, token counters, todo
// The event-log JSONL lives beside messages.json in the same session directory
// and is managed by FileEventLogStore — we never touch it here.

interface SessionMeta {
  id: string;
  createdAt: number;
  lastAccessedAt: number;
  metadata: SessionMetadata;
}

const zMessage = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.union([z.string(), z.array(zContentBlock)]),
  compacted: z.boolean().optional(),
  createdAt: z.number().optional(),
}) satisfies z.ZodType<Message>;

const zSessionMetadata = z.object({
  totalInputTokens: z.number(),
  totalOutputTokens: z.number(),
  totalCacheReadTokens: z.number(),
  totalCacheWriteTokens: z.number(),
  compactionCount: z.number(),
  lastInputTokens: z.number().optional(),
  todo: z.object({
    items: z.array(z.object({
      text: z.string(),
      done: z.boolean().optional(),
    })),
    updatedAt: z.number(),
  }).optional(),
}) satisfies z.ZodType<SessionMetadata>;

const zSessionMeta = z.object({
  id: z.string(),
  createdAt: z.number(),
  lastAccessedAt: z.number(),
  metadata: zSessionMetadata,
}) satisfies z.ZodType<SessionMeta>;

export class FileSessionStore implements SessionStore {
  constructor(private readonly rootDir: string) {}

  async save(session: Session): Promise<void> {
    const dir = this.getDir(session.id);
    await mkdir(dir, { recursive: true });

    const messagesPath = join(dir, 'messages.json');
    const metaPath = join(dir, 'metadata.json');

    const meta: SessionMeta = zSessionMeta.parse({
      id: session.id,
      createdAt: session.createdAt,
      lastAccessedAt: session.lastAccessedAt,
      metadata: session.metadata,
    });

    await writeJsonAtomic(messagesPath, z.array(zMessage).parse(session.messages));
    await writeJsonAtomic(metaPath, meta);
  }

  async load(id: string): Promise<Session | null> {
    const dir = this.getDir(id);
    try {
      const [messagesRaw, metaRaw] = await Promise.all([
        readFile(join(dir, 'messages.json'), 'utf-8'),
        readFile(join(dir, 'metadata.json'), 'utf-8'),
      ]);
      const messages = z.array(zMessage).parse(JSON.parse(messagesRaw));
      const meta = zSessionMeta.parse(JSON.parse(metaRaw));
      return {
        id: meta.id,
        messages,
        createdAt: meta.createdAt,
        lastAccessedAt: meta.lastAccessedAt,
        metadata: meta.metadata,
      };
    } catch (error) {
      if (isNotFoundError(error)) {
        return null;
      }
      throw error;
    }
  }

  async loadSummary(id: string): Promise<Pick<Session, 'id' | 'createdAt' | 'lastAccessedAt' | 'metadata'> | null> {
    try {
      const raw = await readFile(join(this.getDir(id), 'metadata.json'), 'utf-8');
      const meta = zSessionMeta.parse(JSON.parse(raw));
      return {
        id: meta.id,
        createdAt: meta.createdAt,
        lastAccessedAt: meta.lastAccessedAt,
        metadata: meta.metadata,
      };
    } catch (error) {
      if (isNotFoundError(error)) {
        return null;
      }
      throw error;
    }
  }

  async listSummaries(): Promise<Array<Pick<Session, 'id' | 'createdAt' | 'lastAccessedAt' | 'metadata'>>> {
    const ids = await this.list();
    const summaries = await Promise.all(ids.map((id) => this.loadSummary(id)));
    return summaries.filter((summary): summary is Pick<Session, 'id' | 'createdAt' | 'lastAccessedAt' | 'metadata'> => Boolean(summary));
  }

  async list(): Promise<string[]> {
    try {
      const entries = await readdir(this.rootDir, { withFileTypes: true });
      return entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => decodeURIComponent(entry.name))
        .sort();
    } catch (error) {
      if (isNotFoundError(error)) {
        return [];
      }
      throw error;
    }
  }

  async delete(id: string): Promise<void> {
    await rm(this.getDir(id), { recursive: true, force: true });
  }

  private getDir(id: string): string {
    return join(this.rootDir, encodeURIComponent(id));
  }
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2), 'utf-8');
  await rename(tmp, path);
}

function isNotFoundError(error: unknown): boolean {
  return !!error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT';
}
