// ============================================================
// @berry-agent/a8s-server — Models template store
// ============================================================
//
// Persists the cluster-wide models template (provider/model/tier
// config) as a single JSON file on disk. The "file is the fact source"
// rule applies: workers pull the template at register time, hold their
// own copy, and don't re-fetch on every call. The store is small (one
// file, no concurrent writers because there's only one a8s process per
// store path) so we don't need a database.
//
// API: get() returns null when no template has been set yet (fresh
// install). put() atomic-writes via tmp + rename so a crashed write
// doesn't leave a half-written file that breaks parse on next boot.

import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  modelsTemplateSchema,
  type ModelsTemplate,
} from '@berry-agent/cluster-protocol';

export interface ModelsTemplateRecord {
  template: ModelsTemplate;
  updatedAt: number;
}

export interface ModelsTemplateStoreOptions {
  /** Path to the JSON file. Auto-created on first put(). */
  filePath: string;
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
}

export class ModelsTemplateStore {
  private readonly filePath: string;
  private readonly logger: Pick<Console, 'log' | 'warn' | 'error'>;
  // Cache the parsed record so reads don't hit disk every time. Invalidated
  // on every put(). Lazy-loaded on first read.
  private cache: { record: ModelsTemplateRecord | null; loaded: boolean } = {
    record: null,
    loaded: false,
  };

  constructor(options: ModelsTemplateStoreOptions) {
    this.filePath = options.filePath;
    this.logger = options.logger ?? console;
  }

  async get(): Promise<ModelsTemplateRecord | null> {
    if (this.cache.loaded) return this.cache.record;
    try {
      const raw = await readFile(this.filePath, 'utf-8');
      const parsed = JSON.parse(raw) as { template: unknown; updatedAt: number };
      const template = modelsTemplateSchema.parse(parsed.template);
      this.cache = {
        loaded: true,
        record: { template, updatedAt: parsed.updatedAt },
      };
      return this.cache.record;
    } catch (err) {
      // ENOENT means no template yet — that's a valid empty state.
      if ((err as { code?: string }).code === 'ENOENT') {
        this.cache = { loaded: true, record: null };
        return null;
      }
      this.logger.warn?.(`[models-template] read failed: ${(err as Error).message}`);
      // Don't cache failure — try again next call (caller might fix the file).
      throw err;
    }
  }

  async put(template: ModelsTemplate): Promise<ModelsTemplateRecord> {
    // Validate before persist so a bad payload doesn't corrupt the file.
    const validated = modelsTemplateSchema.parse(template);
    const record: ModelsTemplateRecord = {
      template: validated,
      updatedAt: Date.now(),
    };
    await mkdir(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(tmp, JSON.stringify(record, null, 2), 'utf-8');
    await rename(tmp, this.filePath);
    this.cache = { loaded: true, record };
    return record;
  }
}
