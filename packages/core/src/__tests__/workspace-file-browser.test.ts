import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { AgentScope } from '../scope.js';
import { createAgentFileBrowser } from '../workspace/file-browser.js';

describe('AgentFileBrowser', () => {
  let tmp: string;
  let workspace: string;
  let project: string;
  let outside: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'berry-file-browser-'));
    workspace = join(tmp, 'workspace');
    project = join(tmp, 'project');
    outside = join(tmp, 'outside');
    await mkdir(join(project, 'src'), { recursive: true });
    await mkdir(workspace, { recursive: true });
    await mkdir(outside, { recursive: true });
    workspace = await realpath(workspace);
    project = await realpath(project);
    outside = await realpath(outside);
    await writeFile(join(project, 'README.md'), 'hello\n');
    await writeFile(join(project, 'src', 'index.ts'), 'export const value = 1;\n');
    await writeFile(join(outside, 'secret.txt'), 'secret\n');
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('browses the project root when the scope has a project', async () => {
    const browser = createAgentFileBrowser(new AgentScope(workspace, project));

    const list = await browser.list('src');

    expect(list.root).toEqual({ root: project, kind: 'project' });
    expect(list.path).toBe('src');
    expect(list.entries).toEqual([
      expect.objectContaining({ name: 'index.ts', path: 'src/index.ts', type: 'file' }),
    ]);
  });

  it('falls back to the workspace root when there is no project', async () => {
    await writeFile(join(workspace, 'MEMORY.md'), 'notes\n');
    const browser = createAgentFileBrowser(new AgentScope(workspace));

    const list = await browser.list();

    expect(list.root).toEqual({ root: workspace, kind: 'workspace' });
    expect(list.entries).toEqual([
      expect.objectContaining({ name: 'MEMORY.md', path: 'MEMORY.md', type: 'file' }),
    ]);
  });

  it('reads files with deterministic truncation', async () => {
    const browser = createAgentFileBrowser(new AgentScope(workspace, project), { maxReadBytes: 6 });

    const file = await browser.read('src/index.ts');

    expect(file.name).toBe('index.ts');
    expect(file.content).toBe('export');
    expect(file.truncated).toBe(true);
  });

  it('blocks parent traversal and symlinks that escape the browse root', async () => {
    const browser = createAgentFileBrowser(new AgentScope(workspace, project));

    await expect(browser.list('..')).rejects.toThrow(/escapes agent browse root/);

    await symlink(outside, join(project, 'outside-link'));
    await expect(browser.list('outside-link')).rejects.toThrow(/escapes agent browse root/);
  });
});
