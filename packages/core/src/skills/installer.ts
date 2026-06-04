// ============================================================
// Skill installer — write/remove skills under a skills dir
// ============================================================
// Pure filesystem helpers for installing/removing an agent's skills. Kept
// out of agent.ts so the Agent stays IO-light: it delegates here, then
// invalidates its SkillManager cache so the next turn sees the change.
//
// A skill is a directory `<skillsDir>/<name>/` holding `SKILL.md` (frontmatter
// + body) and optional extra files (scripts/, references/). This matches the
// loader's expectation (loadSkillsFromDir scans subdirs for SKILL.md).

import { mkdir, rm, writeFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

/** A file to write alongside SKILL.md (e.g. a script the skill drives). */
export interface SkillExtraFile {
  /** Path relative to the skill dir, e.g. "scripts/run.sh". No "..". */
  path: string;
  content: string;
}

export interface InstallSkillInput {
  /** Skill dir name (the loader keys skills by this / the frontmatter name). */
  name: string;
  /** Full SKILL.md content (frontmatter + body). */
  content: string;
  /** Optional extra files under the skill dir. */
  files?: SkillExtraFile[];
}

/** Reject names/paths that would escape the skills dir. */
function assertSafeSegment(seg: string, kind: string): void {
  if (!seg || seg.includes('..') || seg.startsWith('/') || seg.includes('\\')) {
    throw new Error(`unsafe skill ${kind}: ${JSON.stringify(seg)}`);
  }
}

/**
 * Install a skill into `skillsDir`. Overwrites if it already exists (upsert).
 * Returns the absolute skill dir path.
 */
export async function installSkill(skillsDir: string, input: InstallSkillInput): Promise<string> {
  assertSafeSegment(input.name, 'name');
  const dir = join(skillsDir, input.name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'SKILL.md'), input.content, 'utf-8');
  for (const f of input.files ?? []) {
    for (const part of f.path.split('/')) assertSafeSegment(part, 'file path segment');
    const dest = join(dir, f.path);
    await mkdir(join(dest, '..'), { recursive: true });
    await writeFile(dest, f.content, 'utf-8');
  }
  return dir;
}

/** Remove a skill dir. No-op if absent. Returns true if something was removed. */
export async function removeSkill(skillsDir: string, name: string): Promise<boolean> {
  assertSafeSegment(name, 'name');
  const dir = join(skillsDir, name);
  try {
    await stat(dir);
  } catch {
    return false;
  }
  await rm(dir, { recursive: true, force: true });
  return true;
}

/** List installed skill dir names (subdirs containing SKILL.md). */
export async function listInstalledSkillNames(skillsDir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(skillsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const names: string[] = [];
  for (const e of entries) {
    if (!e.isDirectory() && !e.isSymbolicLink()) continue;
    try {
      await stat(join(skillsDir, e.name, 'SKILL.md'));
      names.push(e.name);
    } catch {
      /* not a skill dir */
    }
  }
  return names;
}
