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
 * Load all skills from a skills directory.
 * Scans for subdirectories containing SKILL.md (case-insensitive).
 *
 * @param skillsDir Path to the skills directory (e.g., "./skills" or "~/.config/skills")
 * @returns Array of loaded skills with parsed metadata
 */
export async function loadSkillsFromDir(skillsDir: string): Promise<Skill[]> {
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
    const skill = await loadSkill(skillDir);
    if (skill) skills.push(skill);
  }

  return skills;
}

/**
 * Load a single skill from a directory.
 * Looks for SKILL.md or skill.md in the directory.
 */
export async function loadSkill(skillDir: string): Promise<Skill | null> {
  const resolvedDir = resolve(skillDir);
  const dirName = basename(resolvedDir);

  // Try both cases
  for (const filename of ['SKILL.md', 'skill.md']) {
    const filePath = join(resolvedDir, filename);
    try {
      await stat(filePath);
      const raw = await readFile(filePath, 'utf-8');
      const { data: frontmatter, content } = matter(raw);

      const meta = parseFrontmatter(frontmatter, dirName);
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
 */
function parseFrontmatter(fm: Record<string, any>, dirName: string): SkillMeta {
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
    source: asSkillSource(fm.source),
    authorAgent: asString(fm.author_agent) ?? asString(fm['author-agent']) ?? asString(fm.authorAgent),
    createdAt: asString(fm.created_at) ?? asString(fm['created-at']) ?? asString(fm.createdAt),
  };
}

function asSkillSource(v: unknown): SkillMeta['source'] {
  if (v === 'global' || v === 'user' || v === 'market' || v === 'self-authored') {
    return v;
  }
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
    // Mark self-authored skills so the agent sees its own provenance and can
    // reason about trust / staleness when deciding whether to load_skill.
    if (s.meta.source === 'self-authored') {
      const parts: string[] = ['self-authored'];
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
