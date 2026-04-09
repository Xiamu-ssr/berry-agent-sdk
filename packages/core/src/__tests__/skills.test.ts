import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadSkillsFromDir, loadSkill, buildSkillIndex } from '../skills/loader.js';

let tempDir: string;

beforeAll(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'berry-skills-test-'));

  // Skill 1: full frontmatter (CC-style)
  const skill1Dir = join(tempDir, 'code-review');
  await mkdir(skill1Dir, { recursive: true });
  await writeFile(join(skill1Dir, 'SKILL.md'), `---
name: code-review
description: Reviews code for bugs, security issues, and style violations.
when_to_use: When reviewing pull requests or checking code quality.
version: 1.2.0
allowed-tools:
  - Read
  - Write
  - Bash
model: claude-sonnet-4-20250514
---

# Code Review

## Instructions

Review the code thoroughly...
`);

  // Skill 2: minimal frontmatter (ClawHub-style)
  const skill2Dir = join(tempDir, 'todoist-cli');
  await mkdir(skill2Dir, { recursive: true });
  await writeFile(join(skill2Dir, 'SKILL.md'), `---
name: todoist-cli
description: Manage Todoist tasks from the command line.
version: 1.0.0
metadata:
  openclaw:
    requires:
      env:
        - TODOIST_API_KEY
---

# Todoist CLI

Use curl to interact with the Todoist API...
`);

  // Skill 3: lowercase skill.md, no name field (uses dir name)
  const skill3Dir = join(tempDir, 'quick-test');
  await mkdir(skill3Dir, { recursive: true });
  await writeFile(join(skill3Dir, 'skill.md'), `---
description: Runs tests quickly.
---

Run the test suite...
`);

  // Skill 4: no SKILL.md (should be skipped)
  const skill4Dir = join(tempDir, 'empty-dir');
  await mkdir(skill4Dir, { recursive: true });
  await writeFile(join(skill4Dir, 'README.md'), '# Not a skill');

  // Non-directory file (should be skipped)
  await writeFile(join(tempDir, 'random.txt'), 'not a skill');
});

afterAll(async () => {
  await rm(tempDir, { recursive: true });
});

describe('loadSkillsFromDir', () => {
  it('loads all valid skills from a directory', async () => {
    const skills = await loadSkillsFromDir(tempDir);
    const names = skills.map(s => s.meta.name).sort();
    expect(names).toEqual(['code-review', 'quick-test', 'todoist-cli']);
  });

  it('parses CC-style frontmatter correctly', async () => {
    const skills = await loadSkillsFromDir(tempDir);
    const cr = skills.find(s => s.meta.name === 'code-review')!;

    expect(cr.meta.description).toBe('Reviews code for bugs, security issues, and style violations.');
    expect(cr.meta.whenToUse).toBe('When reviewing pull requests or checking code quality.');
    expect(cr.meta.version).toBe('1.2.0');
    expect(cr.meta.allowedTools).toEqual(['Read', 'Write', 'Bash']);
    expect(cr.meta.model).toBe('claude-sonnet-4-20250514');
    expect(cr.meta.userInvocable).toBe(true);
  });

  it('handles ClawHub metadata gracefully (ignores unknown fields)', async () => {
    const skills = await loadSkillsFromDir(tempDir);
    const todoist = skills.find(s => s.meta.name === 'todoist-cli')!;

    expect(todoist.meta.description).toBe('Manage Todoist tasks from the command line.');
    expect(todoist.meta.version).toBe('1.0.0');
    // metadata.openclaw is ignored silently
  });

  it('uses directory name when name field is missing', async () => {
    const skills = await loadSkillsFromDir(tempDir);
    const qt = skills.find(s => s.meta.name === 'quick-test')!;

    expect(qt.meta.name).toBe('quick-test');
    expect(qt.meta.description).toBe('Runs tests quickly.');
  });

  it('loads content without frontmatter', async () => {
    const skills = await loadSkillsFromDir(tempDir);
    const cr = skills.find(s => s.meta.name === 'code-review')!;

    expect(cr.content).toContain('# Code Review');
    expect(cr.content).toContain('Review the code thoroughly');
    expect(cr.content).not.toContain('---'); // frontmatter stripped
  });

  it('skips directories without SKILL.md', async () => {
    const skills = await loadSkillsFromDir(tempDir);
    expect(skills.find(s => s.meta.name === 'empty-dir')).toBeUndefined();
  });

  it('returns empty for nonexistent directory', async () => {
    const skills = await loadSkillsFromDir('/nonexistent/path');
    expect(skills).toEqual([]);
  });
});

describe('loadSkill', () => {
  it('loads a single skill from a directory', async () => {
    const skill = await loadSkill(join(tempDir, 'code-review'));
    expect(skill).not.toBeNull();
    expect(skill!.meta.name).toBe('code-review');
    expect(skill!.dir).toContain('code-review');
    expect(skill!.filePath).toContain('SKILL.md');
  });

  it('returns null for directory without SKILL.md', async () => {
    const skill = await loadSkill(join(tempDir, 'empty-dir'));
    expect(skill).toBeNull();
  });
});

describe('buildSkillIndex', () => {
  it('generates lightweight system prompt index', async () => {
    const skills = await loadSkillsFromDir(tempDir);
    const index = buildSkillIndex(skills);

    expect(index).toContain('Available skills:');
    expect(index).toContain('code-review: Reviews code');
    expect(index).toContain('(use when:');
    expect(index).toContain('todoist-cli: Manage Todoist');
    // Should NOT contain full content
    expect(index).not.toContain('Review the code thoroughly');
    expect(index).not.toContain('# Code Review');
  });

  it('returns empty string for no skills', () => {
    expect(buildSkillIndex([])).toBe('');
  });
});
