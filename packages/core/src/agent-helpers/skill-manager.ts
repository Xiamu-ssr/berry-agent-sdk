// ============================================================
// SkillManager — cached skill loading
// ============================================================
// Owns skill-dir state + load cache for Agent. Extracted so that
// agent.ts doesn't have to interleave lazy-load bookkeeping with
// the agent loop.

import { loadSkillsFromDir, buildSkillIndex } from '../skills/loader.js';
import type { Skill, SkillDirSpec } from '../skills/types.js';

export interface SkillManagerOptions {
  /** Normalized skill-dir specs (preserves per-dir provenance defaults). */
  skillDirs: SkillDirSpec[];
  /** Names of skills to exclude from the loaded set. */
  disabledSkills: Set<string>;
}

/**
 * Caches the result of scanning `skillDirs`. Agent creates one per instance
 * and wipes the cache on reload if (future) hot-reload needs it.
 */
export class SkillManager {
  private readonly skillDirs: SkillDirSpec[];
  private readonly disabledSkills: Set<string>;
  private loaded: Skill[] | null = null;

  constructor(options: SkillManagerOptions) {
    this.skillDirs = options.skillDirs;
    this.disabledSkills = options.disabledSkills;
  }

  /** Cached view for synchronous consumers (introspection, getSkillMetas). */
  get loadedSnapshot(): readonly Skill[] | null {
    return this.loaded;
  }

  hasSkillDirs(): boolean {
    return this.skillDirs.length > 0;
  }

  /** Lazy-load skills from all configured skill directories. */
  async getLoadedSkills(): Promise<Skill[]> {
    if (this.loaded) return this.loaded;

    const allSkills: Skill[] = [];
    for (const spec of this.skillDirs) {
      const skills = await loadSkillsFromDir(spec.dir, {
        defaultSource: spec.defaultSource,
        defaultAuthorAgent: spec.defaultAuthorAgent,
      });
      allSkills.push(...skills);
    }

    // Filter out disabled skills, then deduplicate by name (first wins).
    const seen = new Set<string>();
    this.loaded = allSkills.filter((s) => {
      if (this.disabledSkills.has(s.meta.name)) return false;
      if (seen.has(s.meta.name)) return false;
      seen.add(s.meta.name);
      return true;
    });

    return this.loaded;
  }

  async getSkill(name: string): Promise<Skill | null> {
    const skills = await this.getLoadedSkills();
    return skills.find((s) => s.meta.name === name) ?? null;
  }

  async getSkillIndexes(): Promise<
    Array<{ name: string; description: string; whenToUse?: string }>
  > {
    const skills = await this.getLoadedSkills();
    return skills.map((s) => ({
      name: s.meta.name,
      description: s.meta.description,
      whenToUse: s.meta.whenToUse,
    }));
  }

  /**
   * Render the skill index block (for buildSystemPrompt). Returns null when
   * no skill directories are configured.
   */
  async renderIndexBlock(): Promise<string | null> {
    if (!this.hasSkillDirs()) return null;
    const skills = await this.getLoadedSkills();
    return buildSkillIndex(skills);
  }

  /**
   * Invalidate the load cache so the next read re-scans skill dirs from disk.
   * Call after a skill is installed/removed on disk (e.g. via the agent's
   * skill-write API) so the system-prompt index reflects the change on the
   * next turn — without rebuilding the whole runtime.
   */
  reload(): void {
    this.loaded = null;
  }
}
