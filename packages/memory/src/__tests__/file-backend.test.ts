/**
 * FileMemoryBackend unit tests
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FileMemoryBackend } from '../file-backend.js';

describe('FileMemoryBackend', () => {
  let dir: string;
  let backend: FileMemoryBackend;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'berry-memory-test-'));
    backend = new FileMemoryBackend({ dir });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('should start empty', async () => {
    const results = await backend.search('anything');
    expect(results).toEqual([]);
    const all = await backend.list();
    expect(all).toEqual([]);
  });

  it('should add and list entries', async () => {
    await backend.add('First memory note');
    await backend.add('Second memory note');
    const all = await backend.list({ order: 'asc' });
    expect(all).toHaveLength(2);
    expect(all[0].content).toBe('First memory note');
    expect(all[1].content).toBe('Second memory note');
  });

  it('should persist entries to disk', async () => {
    await backend.add('Persistent entry');
    const backend2 = new FileMemoryBackend({ dir });
    const all = await backend2.list();
    expect(all).toHaveLength(1);
    expect(all[0].content).toBe('Persistent entry');
  });

  it('should search by substring', async () => {
    await backend.add('The quick brown fox');
    await backend.add('The lazy dog');
    await backend.add('Another brown thing');
    const results = await backend.search('brown');
    expect(results).toHaveLength(2);
    expect(results[0].content).toContain('brown');
    expect(results[1].content).toContain('brown');
  });

  it('should search case-insensitively', async () => {
    await backend.add('TypeScript is great');
    const results = await backend.search('typescript');
    expect(results).toHaveLength(1);
  });

  it('should filter by metadata', async () => {
    await backend.add('Agent A note', { agentId: 'agent-a' });
    await backend.add('Agent B note', { agentId: 'agent-b' });
    await backend.add('No agent note');
    const results = await backend.search('note', { filter: { agentId: 'agent-a' } });
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe('Agent A note');
  });

  it('should respect limit', async () => {
    for (let i = 0; i < 10; i++) {
      await backend.add(`Memory entry ${i}`);
    }
    const results = await backend.search('Memory', { limit: 3 });
    expect(results).toHaveLength(3);
  });

  it('should get entry by id', async () => {
    const id = await backend.add('Specific entry');
    const entry = await backend.get(id);
    expect(entry).not.toBeNull();
    expect(entry!.content).toBe('Specific entry');
  });

  it('should update entry', async () => {
    const id = await backend.add('Original');
    await backend.update(id, 'Updated');
    const entry = await backend.get(id);
    expect(entry!.content).toBe('Updated');
  });

  it('should delete entry', async () => {
    const id = await backend.add('To delete');
    await backend.delete(id);
    const entry = await backend.get(id);
    expect(entry).toBeNull();
  });

  it('should assign unique ids to entries', async () => {
    const id1 = await backend.add('Entry 1');
    const id2 = await backend.add('Entry 2');
    expect(id1).toBeDefined();
    expect(id2).toBeDefined();
    expect(id1).not.toBe(id2);
  });

  it('should store timestamps', async () => {
    const before = Date.now();
    await backend.add('Timestamped entry');
    const after = Date.now();
    const all = await backend.list();
    expect(all[0].createdAt).toBeGreaterThanOrEqual(before);
    expect(all[0].createdAt).toBeLessThanOrEqual(after);
  });

  it('should store metadata', async () => {
    await backend.add('With metadata', { agentId: 'test-agent' });
    const all = await backend.list();
    expect(all[0].metadata).toEqual({ agentId: 'test-agent' });
  });

  it('should return empty for no-match search', async () => {
    await backend.add('Hello world');
    const results = await backend.search('xyz123');
    expect(results).toEqual([]);
  });

  it('should work via asAgentMemory bridge', async () => {
    const memory = backend.asAgentMemory();
    await memory.append('Via bridge');
    const entries = await backend.list();
    expect(entries).toHaveLength(1);
    expect(entries[0].content).toBe('Via bridge');
  });

  it('should count entries', async () => {
    expect(await backend.count()).toBe(0);
    await backend.add('One');
    await backend.add('Two');
    expect(await backend.count()).toBe(2);
  });

  it('should clear all entries', async () => {
    await backend.add('One');
    await backend.add('Two');
    await backend.clear();
    expect(await backend.count()).toBe(0);
  });

  it('should create directory if it does not exist', async () => {
    const nested = join(dir, 'nested', 'deep');
    const nestedBackend = new FileMemoryBackend({ dir: nested });
    await nestedBackend.add('Deep entry');
    expect(existsSync(nested)).toBe(true);
    const all = await nestedBackend.list();
    expect(all).toHaveLength(1);
  });
});
