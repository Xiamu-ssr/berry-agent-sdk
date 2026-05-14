import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Message, Session, SessionMetadata, SessionStore } from '../types.js';

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

export class FileSessionStore implements SessionStore {
  constructor(private readonly rootDir: string) {}

  async save(session: Session): Promise<void> {
    const dir = this.getDir(session.id);
    await mkdir(dir, { recursive: true });

    const messagesPath = join(dir, 'messages.json');
    const metaPath = join(dir, 'metadata.json');

    const meta: SessionMeta = {
      id: session.id,
      createdAt: session.createdAt,
      lastAccessedAt: session.lastAccessedAt,
      metadata: session.metadata,
    };

    await writeJsonAtomic(messagesPath, session.messages);
    await writeJsonAtomic(metaPath, meta);
  }

  async load(id: string): Promise<Session | null> {
    const dir = this.getDir(id);
    try {
      const [messagesRaw, metaRaw] = await Promise.all([
        readFile(join(dir, 'messages.json'), 'utf-8'),
        readFile(join(dir, 'metadata.json'), 'utf-8'),
      ]);
      const messages = JSON.parse(messagesRaw) as Message[];
      const meta = JSON.parse(metaRaw) as SessionMeta;
      return {
        id: meta.id,
        messages,
        createdAt: meta.createdAt,
        lastAccessedAt: meta.lastAccessedAt,
        metadata: meta.metadata,
      };
    } catch (error: any) {
      if (error?.code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }

  async list(): Promise<string[]> {
    try {
      const entries = await readdir(this.rootDir, { withFileTypes: true });
      return entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => decodeURIComponent(entry.name))
        .sort();
    } catch (error: any) {
      if (error?.code === 'ENOENT') {
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
