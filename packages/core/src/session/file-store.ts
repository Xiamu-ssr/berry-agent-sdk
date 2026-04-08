import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Session, SessionStore } from '../types.js';

export class FileSessionStore implements SessionStore {
  constructor(private readonly rootDir: string) {}

  async save(session: Session): Promise<void> {
    await mkdir(this.rootDir, { recursive: true });

    const path = this.getPath(session.id);
    const tmpPath = `${path}.tmp`;
    const payload = JSON.stringify(session, null, 2);

    await writeFile(tmpPath, payload, 'utf-8');
    await rename(tmpPath, path);
  }

  async load(id: string): Promise<Session | null> {
    try {
      const raw = await readFile(this.getPath(id), 'utf-8');
      return JSON.parse(raw) as Session;
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
        .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
        .map((entry) => decodeURIComponent(entry.name.slice(0, -'.json'.length)))
        .sort();
    } catch (error: any) {
      if (error?.code === 'ENOENT') {
        return [];
      }
      throw error;
    }
  }

  async delete(id: string): Promise<void> {
    await rm(this.getPath(id), { force: true });
  }

  private getPath(id: string): string {
    return join(this.rootDir, `${encodeURIComponent(id)}.json`);
  }
}
