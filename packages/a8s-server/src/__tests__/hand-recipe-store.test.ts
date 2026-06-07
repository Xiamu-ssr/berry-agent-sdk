// ============================================================
// HandRecipeStore — operator registry + persistence
// ============================================================
// Every recipe references a machine (environment) + a subset of that machine's
// exposed MCP server names. It carries no MCP config of its own — the machine's
// .mcp.json is the single source of truth. The store is plain CRUD over one
// JSON file; no built-ins, no legacy-shape compatibility.

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

  it('registers a Hand referencing a machine + MCP servers, persists across reopen', async () => {
    const file = tmpFile();
    const store = new HandRecipeStore({ filePath: file, logger: silent });
    const saved = await store.register({
      id: 'office-mac-github',
      name: 'GitHub (office-mac)',
      machineId: 'office-mac',
      group: '系统预装',
      mcpServerRefs: ['github'],
    });
    expect(saved.machineId).toBe('office-mac');
    expect(saved.mcpServerRefs).toEqual(['github']);
    expect(saved.group).toBe('系统预装');

    const reopened = new HandRecipeStore({ filePath: file, logger: silent });
    const got = await reopened.get('office-mac-github');
    expect(got).not.toBeNull();
    expect(got!.name).toBe('GitHub (office-mac)');
    expect(got!.machineId).toBe('office-mac');
    expect(got!.mcpServerRefs).toEqual(['github']);
  });

  it('allows an exec-only Hand (no MCP refs)', async () => {
    const store = new HandRecipeStore({ filePath: tmpFile(), logger: silent });
    const saved = await store.register({ id: 'shell-only', name: 'Shell', machineId: 'm-1', mcpServerRefs: [] });
    expect(saved.mcpServerRefs).toEqual([]);
  });

  it('lists recipes sorted by id', async () => {
    const store = new HandRecipeStore({ filePath: tmpFile(), logger: silent });
    for (const id of ['zebra', 'alpha', 'mike']) {
      await store.register({ id, name: id, machineId: 'm-1', mcpServerRefs: [] });
    }
    expect((await store.list()).map((r) => r.id)).toEqual(['alpha', 'mike', 'zebra']);
  });

  it('removes a recipe and reports absence', async () => {
    const store = new HandRecipeStore({ filePath: tmpFile(), logger: silent });
    await store.register({ id: 'temp', name: 'Temp', machineId: 'm-1', mcpServerRefs: [] });
    expect(await store.remove('temp')).toBe(true);
    expect(await store.remove('temp')).toBe(false);
    expect(await store.get('temp')).toBeNull();
  });

  it('rejects a recipe with no machineId (a Hand always names its env)', async () => {
    const store = new HandRecipeStore({ filePath: tmpFile(), logger: silent });
    await expect(store.register({
      // @ts-expect-error — intentionally omitting the required machineId
      id: 'unbound', name: 'Unbound', mcpServerRefs: [],
    })).rejects.toThrow();
  });

  it('does not silently tolerate a corrupt/legacy disk file — surfaces empty + warns', async () => {
    const file = tmpFile();
    // A recipe persisted by an older a8s (mcpServers config map, no mcpServerRefs):
    // the new schema rejects it on parse. We don't normalize legacy shapes.
    writeFileSync(file, JSON.stringify({
      recipes: [{ id: 'legacy', name: 'Legacy', machineId: 'm', mcpServers: { x: { command: 'x' } }, installCommands: [], envVarNames: [] }],
      updatedAt: 0,
    }), 'utf-8');
    const store = new HandRecipeStore({ filePath: file, logger: silent });
    expect(await store.list()).toEqual([]);
  });
});
