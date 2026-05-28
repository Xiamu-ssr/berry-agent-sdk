import { mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { isNoEntryError } from '@berry-agent/small-shared-core';
import { z } from 'zod';

import { writeJsonAtomic } from '../atomic-write.js';
import { parseJsonWithSchema } from '../parse-json.js';
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
    const messagesPath = join(dir, 'messages.json');
    const metaPath = join(dir, 'metadata.json');
    try {
      const [messagesRaw, metaRaw] = await Promise.all([
        readFile(messagesPath, 'utf-8'),
        readFile(metaPath, 'utf-8'),
      ]);
      const messages = parseJsonWithSchema(messagesRaw, z.array(zMessage), `session messages "${messagesPath}"`);
      const meta = parseJsonWithSchema(metaRaw, zSessionMeta, `session metadata "${metaPath}"`);
      return {
        id: meta.id,
        messages,
        createdAt: meta.createdAt,
        lastAccessedAt: meta.lastAccessedAt,
        metadata: meta.metadata,
      };
    } catch (error) {
      if (isNoEntryError(error)) {
        return null;
      }
      throw error;
    }
  }

  async loadSummary(id: string): Promise<Pick<Session, 'id' | 'createdAt' | 'lastAccessedAt' | 'metadata'> | null> {
    const metaPath = join(this.getDir(id), 'metadata.json');
    try {
      const raw = await readFile(metaPath, 'utf-8');
      const meta = parseJsonWithSchema(raw, zSessionMeta, `session metadata "${metaPath}"`);
      return {
        id: meta.id,
        createdAt: meta.createdAt,
        lastAccessedAt: meta.lastAccessedAt,
        metadata: meta.metadata,
      };
    } catch (error) {
      if (isNoEntryError(error)) {
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
      if (isNoEntryError(error)) {
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


