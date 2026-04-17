// ============================================================
// Berry Agent SDK — Credential Store
// ============================================================
// Unified interface for resolving secrets (API keys, tokens) without
// letting individual tools reach into process.env directly.
//
// Design goals:
//   1. Tools declare required secrets by name (e.g. 'TAVILY_API_KEY').
//   2. SDK never mandates where secrets live — env / file / vault all work.
//   3. Per-agent credential isolation is possible by swapping the store.

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

/**
 * Synchronous credential lookup. Tools pass in a required key name; the
 * store returns the secret string or undefined if not configured.
 */
export interface CredentialStore {
  get(key: string): string | undefined;
  /**
   * List all known credential keys (optional — used by Settings UIs
   * to render status). Not all stores expose this.
   */
  list?(): string[];
}

/**
 * Default store: env-first, falls back to a JSON file on disk.
 *
 * File schema:
 * ```json
 * { "TAVILY_API_KEY": "tvly-xxx", "BRAVE_API_KEY": "BSA-xxx" }
 * ```
 *
 * The file is loaded synchronously on first lookup and cached.
 */
export class DefaultCredentialStore implements CredentialStore {
  private filePath?: string;
  private fileCache?: Record<string, string>;
  private fileLoaded = false;

  constructor(options?: { filePath?: string }) {
    this.filePath = options?.filePath;
  }

  get(key: string): string | undefined {
    const envVal = process.env[key];
    if (envVal && envVal.trim().length > 0) return envVal;

    if (!this.fileLoaded) {
      this.loadFileSync();
      this.fileLoaded = true;
    }
    return this.fileCache?.[key];
  }

  list(): string[] {
    if (!this.fileLoaded) {
      this.loadFileSync();
      this.fileLoaded = true;
    }
    const envKeys = Object.keys(process.env).filter(
      (k) => typeof process.env[k] === 'string' && (process.env[k] ?? '').length > 0,
    );
    const fileKeys = this.fileCache ? Object.keys(this.fileCache) : [];
    return Array.from(new Set([...envKeys, ...fileKeys]));
  }

  /**
   * Persist a credential to the backing file (env-set keys are ignored —
   * products should instead write to the file so env remains source of truth
   * for env-configured deployments).
   */
  async set(key: string, value: string): Promise<void> {
    if (!this.filePath) throw new Error('DefaultCredentialStore: filePath not configured');
    if (!this.fileCache) this.fileCache = {};
    this.fileCache[key] = value;
    await writeJsonAtomic(this.filePath, this.fileCache);
  }

  private loadFileSync(): void {
    if (!this.filePath) return;
    try {
      // Use readFileSync to keep get() sync
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { readFileSync } = require('node:fs');
      const raw = readFileSync(this.filePath, 'utf-8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        this.fileCache = parsed as Record<string, string>;
      }
    } catch {
      // file missing or unreadable — fine
    }
  }
}

/**
 * In-memory credential store. Useful for tests and short-lived agents.
 */
export class MemoryCredentialStore implements CredentialStore {
  constructor(private entries: Record<string, string> = {}) {}

  get(key: string): string | undefined {
    return this.entries[key];
  }

  list(): string[] {
    return Object.keys(this.entries);
  }

  set(key: string, value: string): void {
    this.entries[key] = value;
  }

  delete(key: string): void {
    delete this.entries[key];
  }
}

/**
 * Convenience: default path for berry-claw style products.
 */
export function defaultCredentialFilePath(): string {
  return join(homedir(), '.berry-claw', 'credentials.json');
}

async function writeJsonAtomic(path: string, data: Record<string, string>): Promise<void> {
  const dir = path.slice(0, path.lastIndexOf('/'));
  await fs.mkdir(dir, { recursive: true });
  const tmp = `${path}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  await fs.rename(tmp, path);
  try {
    await fs.chmod(path, 0o600);
  } catch {
    // best-effort on Windows
  }
}
