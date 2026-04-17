// ============================================================
// Credential Store — unit tests
// ============================================================

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DefaultCredentialStore, MemoryCredentialStore } from '../credentials.js';

describe('MemoryCredentialStore', () => {
  it('get/set/delete', () => {
    const store = new MemoryCredentialStore({ A: '1' });
    expect(store.get('A')).toBe('1');
    expect(store.get('B')).toBeUndefined();
    store.set('B', '2');
    expect(store.get('B')).toBe('2');
    expect(store.list().sort()).toEqual(['A', 'B']);
    store.delete('A');
    expect(store.get('A')).toBeUndefined();
  });
});

describe('DefaultCredentialStore', () => {
  let tmpDir: string;
  let filePath: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(join(tmpdir(), 'berry-cred-'));
    filePath = join(tmpDir, 'credentials.json');
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
    delete process.env.BERRY_TEST_KEY;
  });

  it('reads from env first', () => {
    process.env.BERRY_TEST_KEY = 'from-env';
    const store = new DefaultCredentialStore({ filePath });
    expect(store.get('BERRY_TEST_KEY')).toBe('from-env');
  });

  it('falls back to file when env not set', async () => {
    await fs.writeFile(filePath, JSON.stringify({ BERRY_TEST_KEY: 'from-file' }));
    const store = new DefaultCredentialStore({ filePath });
    expect(store.get('BERRY_TEST_KEY')).toBe('from-file');
  });

  it('env takes precedence over file', async () => {
    await fs.writeFile(filePath, JSON.stringify({ BERRY_TEST_KEY: 'from-file' }));
    process.env.BERRY_TEST_KEY = 'from-env';
    const store = new DefaultCredentialStore({ filePath });
    expect(store.get('BERRY_TEST_KEY')).toBe('from-env');
  });

  it('returns undefined when neither source has the key', () => {
    const store = new DefaultCredentialStore({ filePath });
    expect(store.get('MISSING_KEY_FOR_TEST')).toBeUndefined();
  });

  it('set() persists to file atomically', async () => {
    const store = new DefaultCredentialStore({ filePath });
    await store.set('BERRY_TEST_KEY', 'written');
    const raw = await fs.readFile(filePath, 'utf-8');
    expect(JSON.parse(raw)).toMatchObject({ BERRY_TEST_KEY: 'written' });
  });

  it('set() applies 600 permissions on POSIX', async () => {
    if (process.platform === 'win32') return;
    const store = new DefaultCredentialStore({ filePath });
    await store.set('BERRY_TEST_KEY', 'secret');
    const stat = await fs.stat(filePath);
    // Mask to perm bits only; should be 0600
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it('set() without filePath throws', async () => {
    const store = new DefaultCredentialStore();
    await expect(store.set('X', 'y')).rejects.toThrow(/filePath not configured/);
  });

  it('list() only returns file-backed keys (no env bleed)', async () => {
    await fs.writeFile(filePath, JSON.stringify({ FILE_ONLY_KEY_TEST: 'v' }));
    process.env.BERRY_TEST_KEY = 'env-only';
    const store = new DefaultCredentialStore({ filePath });
    const keys = store.list();
    expect(keys).toEqual(['FILE_ONLY_KEY_TEST']);
    expect(keys).not.toContain('BERRY_TEST_KEY');
    expect(keys).not.toContain('PATH');
  });

  it('has(key) works for both env and file', async () => {
    await fs.writeFile(filePath, JSON.stringify({ FILE_KEY: 'v' }));
    process.env.BERRY_TEST_KEY = 'v';
    const store = new DefaultCredentialStore({ filePath });
    expect(store.has('FILE_KEY')).toBe(true);
    expect(store.has('BERRY_TEST_KEY')).toBe(true);
    expect(store.has('NOT_SET_KEY_FOR_TEST')).toBe(false);
  });

  it('source(key) distinguishes env from file', async () => {
    await fs.writeFile(filePath, JSON.stringify({ FILE_KEY: 'v' }));
    process.env.BERRY_TEST_KEY = 'v';
    const store = new DefaultCredentialStore({ filePath });
    expect(store.source('BERRY_TEST_KEY')).toBe('env');
    expect(store.source('FILE_KEY')).toBe('file');
    expect(store.source('NEITHER_KEY_FOR_TEST')).toBeNull();
  });

  it('env precedence reported in source()', async () => {
    await fs.writeFile(filePath, JSON.stringify({ BERRY_TEST_KEY: 'from-file' }));
    process.env.BERRY_TEST_KEY = 'from-env';
    const store = new DefaultCredentialStore({ filePath });
    expect(store.source('BERRY_TEST_KEY')).toBe('env');
  });

  it('delete() removes a file-backed credential', async () => {
    await fs.writeFile(filePath, JSON.stringify({ BERRY_TEST_KEY: 'v' }));
    const store = new DefaultCredentialStore({ filePath });
    expect(store.has('BERRY_TEST_KEY')).toBe(true);
    await store.delete('BERRY_TEST_KEY');
    expect(store.has('BERRY_TEST_KEY')).toBe(false);
    const raw = await fs.readFile(filePath, 'utf-8');
    expect(JSON.parse(raw)).not.toHaveProperty('BERRY_TEST_KEY');
  });

  it('delete() is a no-op for missing keys', async () => {
    const store = new DefaultCredentialStore({ filePath });
    await expect(store.delete('NOPE')).resolves.toBeUndefined();
  });
});
