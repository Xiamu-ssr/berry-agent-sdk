// ============================================================
// Berry Agent SDK — Skill Loader
// ============================================================
// Loads SKILL.md files from skills directories.
// Compatible with CC, ClawHub, and SkillsDirectory formats.
//
// Directory structure:
//   skills/
//     my-skill/
//       SKILL.md          ← required (frontmatter + instructions)
//       references/       ← optional
//       scripts/          ← optional

import { readFile, readdir, stat } from 'node:fs/promises';
import { join, basename, resolve } from 'node:path';
import matter from 'gray-matter';
import type { Skill, SkillMeta, SkillIndex } from './types.js';

/**
 * Options for filling in missing SkillMeta fields when the loader discovers
 * a skill whose frontmatter didn't declare them. The loader never overrides
 * explicit frontmatter — defaults only fire when the field is absent.
 *
 * Host products use this to stamp provenance on a whole directory:
 *   - passing a per-agent workspace dir → `{defaultSource: 'per-agent',
 *     defaultAuthorAgent: agentId}` marks hand-placed files as attributed to
 *     that agent without requiring the user to write frontmatter.
 *   - passing a global pool dir → `{defaultSource: 'global'}`.
 */
export interface LoadSkillsOptions {
  /** Value to populate `source` when frontmatter omits it. */
  defaultSource?: SkillMeta['source'];
  /** Value to populate `authorAgent` when frontmatter omits it. */
  defaultAuthorAgent?: string;
}

/**
 * Load all skills from a skills directory.
 * Scans for subdirectories containing SKILL.md (case-insensitive).
 *
 * @param skillsDir Path to the skills directory (e.g., "./skills" or "~/.config/skills")
 * @param options   Default-value injections for missing frontmatter fields.
 * @returns Array of loaded skills with parsed metadata
 */
export async function loadSkillsFromDir(
  skillsDir: string,
  options: LoadSkillsOptions = {},
): Promise<Skill[]> {
  const resolvedDir = resolve(skillsDir);
  let entries;
  try {
    entries = await readdir(resolvedDir, { withFileTypes: true });
  } catch {
    return []; // Directory doesn't exist, that's fine
  }

  const skills: Skill[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;

    const skillDir = join(resolvedDir, entry.name);
    const skill = await loadSkill(skillDir, options);
    if (skill) skills.push(skill);
  }

  return skills;
}

/**
 * Load a single skill from a directory.
 * Looks for SKILL.md or skill.md in the directory.
 */
export async function loadSkill(
  skillDir: string,
  options: LoadSkillsOptions = {},
): Promise<Skill | null> {
  const resolvedDir = resolve(skillDir);
  const dirName = basename(resolvedDir);

  // Try both cases
  for (const filename of ['SKILL.md', 'skill.md']) {
    const filePath = join(resolvedDir, filename);
    try {
      const fileStat = await stat(filePath);
      const raw = await readFile(filePath, 'utf-8');
      const { data: frontmatter, content } = matter(raw);

      const meta = parseFrontmatter(frontmatter, dirName, options, fileStat.mtime);
      return {
        meta,
        content: content.trim(),
        dir: resolvedDir,
        filePath,
      };
    } catch {
      continue; // File doesn't exist, try next
    }
  }

  return null; // No SKILL.md found
}

/**
 * Parse frontmatter into SkillMeta.
 * Handles CC, ClawHub, and SkillsDirectory fields.
 *
 * Defaults (source / authorAgent / createdAt) only kick in when the
 * frontmatter doesn't declare the field — explicit values always win so
 * a hand-written override still round-trips.
 */
function parseFrontmatter(
  fm: Record<string, any>,
  dirName: string,
  options: LoadSkillsOptions,
  fileMtime: Date,
): SkillMeta {
  const declaredSource = asSkillSource(fm.source);
  const declaredAuthor =
    asString(fm.author_agent) ?? asString(fm['author-agent']) ?? asString(fm.authorAgent);
  const declaredCreatedAt =
    asString(fm.created_at) ?? asString(fm['created-at']) ?? asString(fm.createdAt);

  return {
    name: asString(fm.name) ?? dirName,
    description: asString(fm.description) ?? `Skill: ${dirName}`,
    whenToUse: asString(fm.when_to_use) ?? asString(fm['when-to-use']),
    version: asString(fm.version),
    allowedTools: asStringArray(fm['allowed-tools']) ?? asStringArray(fm.allowed_tools),
    model: asString(fm.model),
    userInvocable: fm['user-invocable'] !== undefined
      ? Boolean(fm['user-invocable'])
      : true,
    paths: asStringArray(fm.paths),
    source: declaredSource ?? options.defaultSource,
    authorAgent: declaredAuthor ?? options.defaultAuthorAgent,
    // File mtime is our best proxy for "when the skill entered the system".
    // It's not perfect (a `touch` bumps it), but it beats leaving undefined —
    // the UI and buildSkillIndex both use createdAt for ordering/display.
    createdAt: declaredCreatedAt ?? fileMtime.toISOString(),
  };
}

function asSkillSource(v: unknown): SkillMeta['source'] {
  if (v === 'global' || v === 'per-agent') return v;
  return undefined;
}

/**
 * Generate system prompt index from skills (lightweight, no full content).
 * This is what gets injected into the system prompt.
 */
export function buildSkillIndex(skills: Skill[]): string {
  if (skills.length === 0) return '';

  const entries = skills.map(s => {
    let entry = `- ${s.meta.name}: ${s.meta.description}`;
    if (s.meta.whenToUse) entry += ` (use when: ${s.meta.whenToUse})`;
    // Tag per-agent skills with authorship so the agent can reason about
    // trust / staleness when deciding whether to load_skill. Global skills
    // are the host-curated baseline and need no extra annotation.
    if (s.meta.source === 'per-agent') {
      const parts: string[] = ['per-agent'];
      if (s.meta.authorAgent) parts.push(`by ${s.meta.authorAgent}`);
      if (s.meta.createdAt) parts.push(s.meta.createdAt.slice(0, 10));
      entry += ` [${parts.join(', ')}]`;
    }
    return entry;
  });

  return `Available skills:\n${entries.join('\n')}`;
}

/**
 * Get skill indexes for external use.
 */
export function getSkillIndexes(skills: Skill[]): SkillIndex[] {
  return skills.map(s => ({
    name: s.meta.name,
    description: s.meta.description,
    whenToUse: s.meta.whenToUse,
  }));
}

// ===== Helpers =====

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function asStringArray(v: unknown): string[] | undefined {
  if (Array.isArray(v)) {
    const strings = v.filter((x): x is string => typeof x === 'string');
    return strings.length > 0 ? strings : undefined;
  }
  if (typeof v === 'string') {
    return v.split(',').map(s => s.trim()).filter(Boolean);
  }
  return undefined;
}
