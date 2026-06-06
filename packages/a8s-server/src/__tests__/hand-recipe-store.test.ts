// ============================================================
// HandRecipeStore — registry + built-in protection + persistence (B4)
// ============================================================

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
  it('ships built-in recipes and floats them to the top of the list', async () => {
    const store = new HandRecipeStore({ filePath: tmpFile(), logger: silent });
    const list = await store.list();
    const ids = list.map((r) => r.id);
    expect(ids).toContain('playwright');
    expect(ids).toContain('github');
    // built-ins first
    expect(list[0].builtin).toBe(true);
    // playwright needs no secret; github declares the env var NAME, not a value.
    const github = await store.get('github');
    expect(github!.envVarNames).toEqual(['GITHUB_TOKEN']);
    expect(JSON.stringify(github)).not.toContain('ghp_'); // no secret value baked in
  });

  it('registers an operator recipe, forces builtin=false, and persists across reopen', async () => {
    const file = tmpFile();
    const store = new HandRecipeStore({ filePath: file, logger: silent });
    const saved = await store.register({
      id: 'my-fs',
      name: 'Filesystem',
      kind: 'mcp',
      mcpServers: { fs: { command: 'mcp-fs', args: ['/data'] } },
      installCommands: [],
      envVarNames: [],
    });
    expect(saved.builtin).toBe(false);

    const reopened = new HandRecipeStore({ filePath: file, logger: silent });
    const got = await reopened.get('my-fs');
    expect(got).not.toBeNull();
    expect(got!.name).toBe('Filesystem');
    // built-ins still present alongside the persisted custom recipe
    expect((await reopened.list()).some((r) => r.id === 'playwright')).toBe(true);
  });

  it('refuses to overwrite or remove a built-in id', async () => {
    const store = new HandRecipeStore({ filePath: tmpFile(), logger: silent });
    await expect(store.register({
      id: 'playwright',
      name: 'evil',
      kind: 'mcp',
      mcpServers: { x: { command: 'x' } },
      installCommands: [],
      envVarNames: [],
    })).rejects.toThrow(/built-in/);
    await expect(store.remove('playwright')).rejects.toThrow(/built-in/);
  });

  it('removes an operator recipe and reports absence', async () => {
    const store = new HandRecipeStore({ filePath: tmpFile(), logger: silent });
    await store.register({
      id: 'temp', name: 'Temp', kind: 'mcp',
      mcpServers: { t: { command: 't' } }, installCommands: [], envVarNames: [],
    });
    expect(await store.remove('temp')).toBe(true);
    expect(await store.remove('temp')).toBe(false);
    expect(await store.get('temp')).toBeNull();
  });

  it('built-ins are machine-bound Hands carrying a market group', async () => {
    const store = new HandRecipeStore({ filePath: tmpFile(), logger: silent });
    const pw = await store.get('playwright');
    expect(pw!.kind).toBe('machine');
    expect(pw!.group).toBe('系统预装');
  });

  it('persists a machine-bound Hand with machineId + group', async () => {
    const file = tmpFile();
    const store = new HandRecipeStore({ filePath: file, logger: silent });
    const saved = await store.register({
      id: 'android-pixel',
      name: 'Android 设备',
      description: 'adb + uiautomator on a docked Pixel',
      kind: 'machine',
      machineId: 'pixel-dock-1',
      group: '设备',
      mcpServers: { android: { command: 'adb-mcp' } },
      installCommands: [],
      envVarNames: [],
    });
    expect(saved.machineId).toBe('pixel-dock-1');
    expect(saved.group).toBe('设备');

    const reopened = new HandRecipeStore({ filePath: file, logger: silent });
    const got = await reopened.get('android-pixel');
    expect(got!.machineId).toBe('pixel-dock-1');
    expect(got!.kind).toBe('machine');
  });

  it('reads a legacy kind:\'mcp\' disk file and normalizes it to machine', async () => {
    const file = tmpFile();
    // Simulate a recipe persisted by an older a8s (kind:'mcp', no machineId/group).
    writeFileSync(file, JSON.stringify({
      recipes: [{
        id: 'legacy-fs', name: 'Legacy FS', kind: 'mcp',
        mcpServers: { fs: { command: 'mcp-fs' } }, installCommands: [], envVarNames: [], builtin: false,
      }],
      updatedAt: 0,
    }), 'utf-8');
    const store = new HandRecipeStore({ filePath: file, logger: silent });
    const got = await store.get('legacy-fs');
    expect(got).not.toBeNull();
    expect(got!.kind).toBe('machine'); // normalized on read
  });
});
