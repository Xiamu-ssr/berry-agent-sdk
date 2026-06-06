// ============================================================
// SkillStore — catalog + built-in protection + frontmatter parse (B6)
// ============================================================

import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SkillStore, readSkillFrontmatter } from '../skill-store.js';

function tmpFile(): string {
  return join(mkdtempSync(join(tmpdir(), 'a8s-skills-')), 'skill-registry.json');
}
const silent = { log() {}, warn() {}, error() {} };

describe('readSkillFrontmatter', () => {
  it('pulls name + description from a SKILL.md frontmatter block', () => {
    const md = `---\nname: my-skill\ndescription: Does a thing well.\nwhenToUse: sometimes\n---\n\n# Body`;
    expect(readSkillFrontmatter(md)).toEqual({ name: 'my-skill', description: 'Does a thing well.' });
  });
  it('strips surrounding quotes and tolerates missing fields', () => {
    expect(readSkillFrontmatter(`---\nname: "quoted"\n---\n`)).toEqual({ name: 'quoted', description: '' });
    expect(readSkillFrontmatter('no frontmatter here')).toEqual({ name: '', description: '' });
  });
});

describe('SkillStore', () => {
  it('ships built-in skills (a8s-ops, team, cluster, ...) at the top of the catalog', async () => {
    const store = new SkillStore({ filePath: tmpFile(), logger: silent });
    const list = await store.list();
    const names = list.map((s) => s.name);
    expect(names).toContain('a8s-ops');
    expect(names).toContain('team');
    expect(names).toContain('cluster');
    expect(names).toContain('skill-creator');
    expect(list[0].builtin).toBe(true);
    // descriptions parsed from frontmatter, not empty
    expect(list.find((s) => s.name === 'team')!.description).toMatch(/team/i);
  });

  it('carries built-in content verbatim (no rewrite)', async () => {
    const store = new SkillStore({ filePath: tmpFile(), logger: silent });
    const team = await store.get('team');
    expect(team!.content.startsWith('---\nname: team')).toBe(true);
    expect(team!.content).toContain('berry-team');
  });

  it('registers an operator skill, forces builtin=false, persists across reopen', async () => {
    const file = tmpFile();
    const store = new SkillStore({ filePath: file, logger: silent });
    const saved = await store.register({
      name: 'my-skill',
      description: 'Custom skill.',
      content: '---\nname: my-skill\ndescription: Custom skill.\n---\n# Hi',
    });
    expect(saved.builtin).toBe(false);

    const reopened = new SkillStore({ filePath: file, logger: silent });
    const got = await reopened.get('my-skill');
    expect(got!.content).toContain('# Hi');
    expect((await reopened.list()).some((s) => s.name === 'a8s-ops')).toBe(true);
  });

  it('refuses to overwrite or remove a built-in skill', async () => {
    const store = new SkillStore({ filePath: tmpFile(), logger: silent });
    await expect(store.register({
      name: 'team', description: 'evil', content: 'x',
    })).rejects.toThrow(/built-in/);
    await expect(store.remove('team')).rejects.toThrow(/built-in/);
  });

  it('removes an operator skill and reports absence', async () => {
    const store = new SkillStore({ filePath: tmpFile(), logger: silent });
    await store.register({ name: 'temp', description: 'Temp.', content: 'x' });
    expect(await store.remove('temp')).toBe(true);
    expect(await store.remove('temp')).toBe(false);
    expect(await store.get('temp')).toBeNull();
  });
});
