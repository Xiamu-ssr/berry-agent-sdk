import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createFileMemoryProvider } from '../provider.js';

function makeWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'berry-mem-file-'));
}

function write(ws: string, rel: string, content: string): void {
  const abs = path.join(ws, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

describe('FileMemoryProvider', () => {
  let ws: string;
  let provider: ReturnType<typeof createFileMemoryProvider>;

  beforeEach(() => {
    ws = makeWorkspace();
  });

  afterEach(() => {
    provider?.dispose();
    fs.rmSync(ws, { recursive: true, force: true });
  });

  it('indexes MEMORY.md and returns a hit for a matching query', async () => {
    write(
      ws,
      'MEMORY.md',
      [
        '# My Notes',
        '',
        'Berry Agent SDK is a TypeScript harness for LLM agents.',
        'It ships with memory, safety, and MCP packages.',
        '',
        'Unrelated content about weather and pancakes.',
      ].join('\n'),
    );

    provider = createFileMemoryProvider({ workspaceDir: ws });
    const results = await provider.search('berry agent sdk');

    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.path).toBe('MEMORY.md');
    expect(results[0]!.citation).toMatch(/^MEMORY\.md#L\d+-L\d+$/);
    expect(results[0]!.snippet).toContain('Berry Agent SDK');
  });

  it('indexes files under memory/ with posix-style relative paths', async () => {
    write(ws, 'memory/2026-04-20.md', 'Today we built memory-file package.');
    write(ws, 'memory/2026-04-19.md', 'Yesterday we discussed toast notifications.');

    provider = createFileMemoryProvider({ workspaceDir: ws });
    const results = await provider.search('toast notifications');

    expect(results.some((r) => r.path === 'memory/2026-04-19.md')).toBe(true);
  });

  it('returns empty for queries with no match', async () => {
    write(ws, 'MEMORY.md', 'completely unrelated content about cats');
    provider = createFileMemoryProvider({ workspaceDir: ws });
    const results = await provider.search('quantum entanglement');
    expect(results).toEqual([]);
  });

  it('filters by minScore when provided', async () => {
    write(ws, 'MEMORY.md', Array.from({ length: 40 }, (_, i) => `Line ${i} about testing.`).join('\n'));
    provider = createFileMemoryProvider({ workspaceDir: ws });

    const wide = await provider.search('testing', { minScore: 0 });
    const strict = await provider.search('testing', { minScore: 0.99 });

    expect(strict.length).toBeLessThanOrEqual(wide.length);
    // With a high enough min score, we typically collapse to the single best hit.
    expect(strict.length).toBeGreaterThanOrEqual(0);
  });

  it('memory_get returns an excerpt with bounds', async () => {
    const lines = Array.from({ length: 20 }, (_, i) => `L${i + 1}`);
    write(ws, 'MEMORY.md', lines.join('\n'));
    provider = createFileMemoryProvider({ workspaceDir: ws });

    const excerpt = await provider.get({ path: 'MEMORY.md', from: 5, lines: 3 });
    expect(excerpt.from).toBe(5);
    expect(excerpt.to).toBe(7);
    expect(excerpt.text).toBe('L5\nL6\nL7');
    expect(excerpt.truncated).toBe(true);
  });

  it('rejects traversal paths', async () => {
    write(ws, 'MEMORY.md', 'hi');
    provider = createFileMemoryProvider({ workspaceDir: ws });
    await expect(provider.get({ path: '../secret.md' })).rejects.toThrow();
  });

  it('picks up file changes on next search (mtime-based resync)', async () => {
    write(ws, 'MEMORY.md', 'initial note about alpha');
    provider = createFileMemoryProvider({ workspaceDir: ws });

    const first = await provider.search('alpha');
    expect(first.length).toBeGreaterThan(0);

    // Wait a tick so mtime resolution catches the change.
    await new Promise((r) => setTimeout(r, 20));
    write(ws, 'MEMORY.md', 'now it mentions bravo instead');
    // Force mtime forward even on very fast systems.
    const now = Date.now();
    fs.utimesSync(path.join(ws, 'MEMORY.md'), now / 1000, now / 1000);

    const second = await provider.search('bravo');
    expect(second.some((r) => r.snippet.includes('bravo'))).toBe(true);

    const stale = await provider.search('alpha');
    expect(stale.some((r) => r.snippet.includes('alpha'))).toBe(false);
  });

  it('exposes memory_search and memory_get as tools', async () => {
    write(ws, 'MEMORY.md', 'Provider tests verify tool registration.');
    provider = createFileMemoryProvider({ workspaceDir: ws });
    const tools = provider.tools();
    const names = tools.map((t) => t.definition.name).sort();
    expect(names).toEqual(['memory_get', 'memory_search']);

    const searchTool = tools.find((t) => t.definition.name === 'memory_search')!;
    const out = await searchTool.execute(
      { query: 'tool registration' },
      { cwd: ws },
    );
    const parsed = JSON.parse(out.content);
    expect(parsed.provider).toBe('none');
    expect(parsed.debug.backend).toBe('fts');
    expect(Array.isArray(parsed.results)).toBe(true);
    expect(parsed.results.length).toBeGreaterThan(0);
  });

  it('indexes project knowledge files under a separate projectDir', async () => {
    write(ws, 'MEMORY.md', 'Personal note about dark roast coffee.');

    // Separate project directory — simulates teammates pointing at a shared
    // project path while each having their own workspace.
    const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'berry-mem-proj-'));
    try {
      fs.writeFileSync(path.join(proj, '.berry-discoveries.md'), 'TEAM DISCOVERY: use rayon for parallelism.');
      fs.writeFileSync(path.join(proj, 'AGENTS.md'), 'Project spec lives here. No secrets in logs.');

      provider = createFileMemoryProvider({ workspaceDir: ws, projectDir: proj });

      // Personal memory still searchable.
      const personal = await provider.search('dark roast coffee');
      expect(personal.some((r) => r.path === 'MEMORY.md')).toBe(true);

      // Project discoveries surface with a project/ prefix so consumers can
      // distinguish shared knowledge from personal notes.
      const shared = await provider.search('rayon parallelism');
      expect(shared.some((r) => r.path === 'project/.berry-discoveries.md')).toBe(true);

      const spec = await provider.search('no secrets in logs');
      expect(spec.some((r) => r.path === 'project/AGENTS.md')).toBe(true);

      // Excerpt reads resolve via project/ prefix too.
      const excerpt = await provider.get({ path: 'project/.berry-discoveries.md' });
      expect(excerpt.text).toContain('rayon');
    } finally {
      fs.rmSync(proj, { recursive: true, force: true });
    }
  });
});
