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
  /** True iff get(key) would return a non-empty value. */
  has?(key: string): boolean;
  /**
   * Report where a key is resolved from. Useful for Settings UIs.
   * - 'env'  — came from process.env
   * - 'file' — came from backing store
   * - null  — not configured
   */
  source?(key: string): 'env' | 'file' | null;
  /**
   * List known credential keys from the backing store (env-only keys are
   * typically excluded to avoid leaking unrelated env vars into UIs).
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

  /**
   * List credential keys known to this store. Returns file-backed keys only
   * (env typically contains many unrelated variables). Use `has(key)` to
   * check whether a specific key resolves from env or file.
   */
  list(): string[] {
    if (!this.fileLoaded) {
      this.loadFileSync();
      this.fileLoaded = true;
    }
    return this.fileCache ? Object.keys(this.fileCache) : [];
  }

  /**
   * Check whether a specific credential is available (env or file).
   */
  has(key: string): boolean {
    return this.get(key) !== undefined;
  }

  /**
   * Report where a key is resolved from. Useful for Settings UI to show
   * "configured in env" vs "saved to file".
   */
  source(key: string): 'env' | 'file' | null {
    const envVal = process.env[key];
    if (envVal && envVal.trim().length > 0) return 'env';
    if (!this.fileLoaded) {
      this.loadFileSync();
      this.fileLoaded = true;
    }
    if (this.fileCache?.[key]) return 'file';
    return null;
  }

  /**
   * Persist a credential to the backing file. Env-set keys still take
   * precedence on read, but the file value is preserved as a fallback.
   */
  async set(key: string, value: string): Promise<void> {
    if (!this.filePath) throw new Error('DefaultCredentialStore: filePath not configured');
    if (!this.fileLoaded) {
      this.loadFileSync();
      this.fileLoaded = true;
    }
    if (!this.fileCache) this.fileCache = {};
    this.fileCache[key] = value;
    await writeJsonAtomic(this.filePath, this.fileCache);
  }

  /**
   * Remove a credential from the backing file. Env-set keys are not touched.
   */
  async delete(key: string): Promise<void> {
    if (!this.filePath) throw new Error('DefaultCredentialStore: filePath not configured');
    if (!this.fileLoaded) {
      this.loadFileSync();
      this.fileLoaded = true;
    }
    if (!this.fileCache || !(key in this.fileCache)) return;
    delete this.fileCache[key];
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

  has(key: string): boolean {
    return this.get(key) !== undefined;
  }

  source(key: string): 'env' | 'file' | null {
    return this.entries[key] !== undefined ? 'file' : null;
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
