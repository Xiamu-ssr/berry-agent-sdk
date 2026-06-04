// ============================================================
// @berry-agent/a8s-admin — collaboration skills tests
// ============================================================

import { describe, expect, it, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, existsSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TEAM_SKILL, CLUSTER_SKILL, seedCollaborationSkill } from '../collaboration-skills.js';

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'collab-skill-'));
  dirs.push(d);
  return d;
}
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe('collaboration skills', () => {
  it('TEAM_SKILL is hierarchical (lead → teammates), CLUSTER_SKILL is flat (no leader)', () => {
    expect(TEAM_SKILL).toContain('name: team');
    expect(TEAM_SKILL).toMatch(/lead/i);
    expect(CLUSTER_SKILL).toContain('name: cluster');
    expect(CLUSTER_SKILL).toMatch(/no leader|no hierarchy|peer/i);
    // Both drive the same CLI — collaboration is knowledge, not new tools.
    expect(TEAM_SKILL).toContain('berry-team');
    expect(CLUSTER_SKILL).toContain('berry-team');
  });

  it('seeds the requested skill into <workspace>/skills/<kind>/SKILL.md', () => {
    const ws = tmp();
    seedCollaborationSkill(ws, 'team');
    const path = join(ws, 'skills', 'team', 'SKILL.md');
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, 'utf-8')).toContain('name: team');
  });

  it('does not clobber a customized skill on re-seed', () => {
    const ws = tmp();
    const dir = join(ws, 'skills', 'cluster');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), 'custom', 'utf-8');
    seedCollaborationSkill(ws, 'cluster');
    expect(readFileSync(join(dir, 'SKILL.md'), 'utf-8')).toBe('custom');
  });

  it('rejects an unknown kind', () => {
    expect(() => seedCollaborationSkill(tmp(), 'bogus' as never)).toThrow(/unknown/);
  });
});
