// ============================================================
// @berry-agent/a8s-server — Skill registry store
// ============================================================
//
// a8s is the skill market: it catalogs the skills an operator can install
// onto an agent. Two sources:
//   - built-ins shipped with @berry-agent/a8s-admin (a8s-ops, install-worker,
//     team, cluster, skill-creator) — read-only;
//   - operator-registered skills, persisted to a JSON file.
//
// Per the settled invariant (skill format is a unified contract, never
// translated): this store carries SKILL.md content VERBATIM. It parses the
// frontmatter ONLY to surface name/description in listings — it never
// rewrites content, and installing proxies the exact bytes to the agent's
// /skills endpoint. The agent's own loader is the single interpreter.
//
// Persistence mirrors HandRecipeStore: in-memory cache + atomic tmp+rename
// write; built-in names are read-only and always shadow on read.

import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  A8S_OPS_SKILL,
  INSTALL_WORKER_SKILL,
  MCP_SKILL,
  TEAM_SKILL,
  CLUSTER_SKILL,
  SKILL_CREATOR_SKILL,
} from '@berry-agent/a8s-admin';
import type { OperatorSkillRegisterRequest } from '@berry-agent/cluster-protocol';

export interface RegistrySkill {
  name: string;
  description: string;
  content: string;
  files: Array<{ path: string; content: string }>;
  builtin: boolean;
}

/**
 * Pull `name` and `description` out of a SKILL.md YAML frontmatter block. A
 * deliberately tiny parser — we only need these two scalar fields for the
 * listing, and refusing a full YAML dependency keeps a8s-server lean. The
 * full content is still carried verbatim; this never mutates it.
 */
export function readSkillFrontmatter(content: string): { name: string; description: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
  let name = '';
  let description = '';
  if (match) {
    for (const line of match[1].split(/\r?\n/)) {
      const kv = /^(\w+):\s*(.*)$/.exec(line);
      if (!kv) continue;
      const key = kv[1];
      let value = kv[2].trim();
      // Strip matching surrounding quotes if present.
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (key === 'name') name = value;
      else if (key === 'description') description = value;
    }
  }
  return { name, description };
}

function builtinSkill(content: string): RegistrySkill {
  const { name, description } = readSkillFrontmatter(content);
  return { name, description, content, files: [], builtin: true };
}

/** Skills a8s ships out of the box, from @berry-agent/a8s-admin. */
export const BUILTIN_SKILLS: RegistrySkill[] = [
  builtinSkill(A8S_OPS_SKILL),
  builtinSkill(INSTALL_WORKER_SKILL),
  builtinSkill(MCP_SKILL),
  builtinSkill(TEAM_SKILL),
  builtinSkill(CLUSTER_SKILL),
  builtinSkill(SKILL_CREATOR_SKILL),
];

export interface SkillStoreOptions {
  filePath: string;
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
}

interface PersistedShape {
  skills: RegistrySkill[];
  updatedAt: number;
}

export class SkillStore {
  private readonly filePath: string;
  private readonly logger: Pick<Console, 'log' | 'warn' | 'error'>;
  private readonly builtins: Map<string, RegistrySkill>;
  private custom = new Map<string, RegistrySkill>();
  private loaded = false;

  constructor(options: SkillStoreOptions) {
    this.filePath = options.filePath;
    this.logger = options.logger ?? console;
    this.builtins = new Map(BUILTIN_SKILLS.map((s) => [s.name, s]));
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    try {
      const raw = await readFile(this.filePath, 'utf-8');
      const parsed = JSON.parse(raw) as PersistedShape;
      const next = new Map<string, RegistrySkill>();
      for (const entry of parsed.skills ?? []) {
        if (this.builtins.has(entry.name)) continue; // built-ins are read-only
        next.set(entry.name, { ...entry, builtin: false, files: entry.files ?? [] });
      }
      this.custom = next;
    } catch (err) {
      if ((err as { code?: string }).code !== 'ENOENT') {
        this.logger.warn?.(`[skill-registry] read failed: ${(err as Error).message}`);
      }
      this.custom = new Map();
    }
    this.loaded = true;
  }

  /** All skills (built-ins first, then operator skills), sorted by name. */
  async list(): Promise<RegistrySkill[]> {
    await this.ensureLoaded();
    const merged = new Map<string, RegistrySkill>(this.builtins);
    for (const [name, skill] of this.custom) merged.set(name, skill);
    return [...merged.values()].sort((a, b) => {
      if (a.builtin !== b.builtin) return a.builtin ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  }

  async get(name: string): Promise<RegistrySkill | null> {
    await this.ensureLoaded();
    return this.builtins.get(name) ?? this.custom.get(name) ?? null;
  }

  /**
   * Register or update an operator skill. Forces `builtin: false` and rejects
   * reuse of a built-in name so a shipped skill can't be silently shadowed.
   */
  async register(req: OperatorSkillRegisterRequest): Promise<RegistrySkill> {
    await this.ensureLoaded();
    if (this.builtins.has(req.name)) {
      throw new Error(`skill "${req.name}" is built-in and cannot be overwritten`);
    }
    const skill: RegistrySkill = {
      name: req.name,
      description: req.description,
      content: req.content,
      files: req.files ?? [],
      builtin: false,
    };
    this.custom.set(skill.name, skill);
    await this.persist();
    return skill;
  }

  /** Remove an operator skill. Built-ins can't be removed. Returns false if absent. */
  async remove(name: string): Promise<boolean> {
    await this.ensureLoaded();
    if (this.builtins.has(name)) {
      throw new Error(`skill "${name}" is built-in and cannot be removed`);
    }
    const had = this.custom.delete(name);
    if (had) await this.persist();
    return had;
  }

  private async persist(): Promise<void> {
    const record: PersistedShape = {
      skills: [...this.custom.values()],
      updatedAt: Date.now(),
    };
    await mkdir(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(tmp, JSON.stringify(record, null, 2), 'utf-8');
    await rename(tmp, this.filePath);
  }
}
