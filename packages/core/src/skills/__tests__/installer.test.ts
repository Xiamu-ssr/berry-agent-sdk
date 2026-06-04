// ============================================================
// Skill installer tests
// ============================================================

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installSkill, removeSkill, listInstalledSkillNames } from '../installer.js';

describe('skill installer', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'skills-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it('installs a skill as <dir>/<name>/SKILL.md and lists it', async () => {
    await installSkill(dir, { name: 'greeter', content: '---\nname: greeter\n---\nsay hi' });
    expect(await readFile(join(dir, 'greeter', 'SKILL.md'), 'utf-8')).toContain('say hi');
    expect(await listInstalledSkillNames(dir)).toEqual(['greeter']);
  });

  it('writes optional extra files under the skill dir', async () => {
    await installSkill(dir, {
      name: 'runner',
      content: 'x',
      files: [{ path: 'scripts/run.sh', content: 'echo hi' }],
    });
    expect(await readFile(join(dir, 'runner', 'scripts', 'run.sh'), 'utf-8')).toBe('echo hi');
  });

  it('upserts (overwrites) an existing skill', async () => {
    await installSkill(dir, { name: 's', content: 'v1' });
    await installSkill(dir, { name: 's', content: 'v2' });
    expect(await readFile(join(dir, 's', 'SKILL.md'), 'utf-8')).toBe('v2');
  });

  it('removes a skill and reports existence', async () => {
    await installSkill(dir, { name: 's', content: 'x' });
    expect(await removeSkill(dir, 's')).toBe(true);
    expect(await removeSkill(dir, 's')).toBe(false);
    await expect(stat(join(dir, 's'))).rejects.toThrow();
  });

  it('rejects path traversal in name and file paths', async () => {
    await expect(installSkill(dir, { name: '../evil', content: 'x' })).rejects.toThrow(/unsafe/);
    await expect(installSkill(dir, { name: 'ok', content: 'x', files: [{ path: '../../e', content: 'x' }] }))
      .rejects.toThrow(/unsafe/);
  });

  it('listInstalledSkillNames ignores non-skill dirs', async () => {
    await installSkill(dir, { name: 'real', content: 'x' });
    await mkdtemp(join(dir, 'notaskill-')); // dir without SKILL.md
    expect(await listInstalledSkillNames(dir)).toEqual(['real']);
  });
});
