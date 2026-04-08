import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { FileSessionStore } from '../session/file-store.js';
import type { Session } from '../types.js';

const tempDirs: string[] = [];

async function makeStore() {
  const dir = await mkdtemp(join(tmpdir(), 'berry-agent-store-'));
  tempDirs.push(dir);
  return new FileSessionStore(dir);
}

function makeSession(id: string): Session {
  return {
    id,
    systemPrompt: ['test prompt'],
    createdAt: 1,
    lastAccessedAt: 2,
    messages: [
      { role: 'user', content: 'hello', createdAt: 1 },
      { role: 'assistant', content: 'world', createdAt: 2 },
    ],
    metadata: {
      cwd: '/tmp',
      model: 'fake-model',
      totalInputTokens: 1,
      totalOutputTokens: 2,
      totalCacheReadTokens: 3,
      totalCacheWriteTokens: 4,
      compactionCount: 0,
    },
  };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('FileSessionStore', () => {
  it('saves and loads a session', async () => {
    const store = await makeStore();
    const session = makeSession('session-1');

    await store.save(session);

    await expect(store.load('session-1')).resolves.toEqual(session);
  });

  it('lists saved sessions in sorted order and deletes sessions', async () => {
    const store = await makeStore();

    await store.save(makeSession('b/session'));
    await store.save(makeSession('a session'));

    await expect(store.list()).resolves.toEqual(['a session', 'b/session']);

    await store.delete('a session');

    await expect(store.list()).resolves.toEqual(['b/session']);
    await expect(store.load('a session')).resolves.toBeNull();
  });

  it('returns empty values when the directory or file does not exist', async () => {
    const store = await makeStore();

    await rm((store as any).rootDir, { recursive: true, force: true });

    await expect(store.list()).resolves.toEqual([]);
    await expect(store.load('missing')).resolves.toBeNull();
  });
});
