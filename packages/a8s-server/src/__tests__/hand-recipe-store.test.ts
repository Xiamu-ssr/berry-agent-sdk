// ============================================================
// HandRecipeStore — operator registry + persistence
// ============================================================
// Every recipe is machine-bound (machine-inborn) and operator-authored; there
// are no built-ins and no legacy-shape compatibility. The store is plain CRUD
// over one JSON file.

import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HandRecipeStore } from '../hand-recipe-store.js';

function tmpFile(): string {
  return join(mkdtempSync(join(tmpdir(), 'a8s-recipes-')), 'hand-recipes.json');
}

const silent = { log() {}, warn() {}, error() {} };

describe('HandRecipeStore', () => {
  it('starts empty when no file exists', async () => {
    const store = new HandRecipeStore({ filePath: tmpFile(), logger: silent });
    expect(await store.list()).toEqual([]);
  });

  it('registers a machine-bound recipe and persists it across reopen', async () => {
    const file = tmpFile();
    const store = new HandRecipeStore({ filePath: file, logger: silent });
    const saved = await store.register({
      id: 'office-mac-github',
      name: 'GitHub (office-mac)',
      machineId: 'office-mac',
      group: '系统预装',
      mcpServers: { github: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'] } },
      installCommands: [],
      envVarNames: ['GITHUB_TOKEN'],
    });
    expect(saved.machineId).toBe('office-mac');
    expect(saved.group).toBe('系统预装');

    const reopened = new HandRecipeStore({ filePath: file, logger: silent });
    const got = await reopened.get('office-mac-github');
    expect(got).not.toBeNull();
    expect(got!.name).toBe('GitHub (office-mac)');
    expect(got!.machineId).toBe('office-mac');
  });

  it('lists recipes sorted by id', async () => {
    const store = new HandRecipeStore({ filePath: tmpFile(), logger: silent });
    for (const id of ['zebra', 'alpha', 'mike']) {
      await store.register({ id, name: id, machineId: 'm-1', mcpServers: { s: { command: 'x' } }, installCommands: [], envVarNames: [] });
    }
    expect((await store.list()).map((r) => r.id)).toEqual(['alpha', 'mike', 'zebra']);
  });

  it('removes a recipe and reports absence', async () => {
    const store = new HandRecipeStore({ filePath: tmpFile(), logger: silent });
    await store.register({ id: 'temp', name: 'Temp', machineId: 'm-1', mcpServers: { t: { command: 't' } }, installCommands: [], envVarNames: [] });
    expect(await store.remove('temp')).toBe(true);
    expect(await store.remove('temp')).toBe(false);
    expect(await store.get('temp')).toBeNull();
  });

  it('rejects a recipe with no machineId (machine-inborn is required)', async () => {
    const store = new HandRecipeStore({ filePath: tmpFile(), logger: silent });
    await expect(store.register({
      // @ts-expect-error — intentionally omitting the required machineId
      id: 'unbound', name: 'Unbound', mcpServers: { s: { command: 'x' } }, installCommands: [], envVarNames: [],
    })).rejects.toThrow();
  });

  it('does not silently tolerate a corrupt/legacy disk file — surfaces empty + warns', async () => {
    const file = tmpFile();
    // A recipe persisted by an older a8s (kind:'mcp', no machineId): the new
    // schema rejects it on parse. We don't normalize legacy shapes anymore.
    writeFileSync(file, JSON.stringify({
      recipes: [{ id: 'legacy', name: 'Legacy', kind: 'mcp', mcpServers: {}, installCommands: [], envVarNames: [], builtin: false }],
      updatedAt: 0,
    }), 'utf-8');
    const store = new HandRecipeStore({ filePath: file, logger: silent });
    // parse throws inside ensureLoaded → caught → empty map (warned, not crashed).
    expect(await store.list()).toEqual([]);
  });
});
