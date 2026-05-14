// ============================================================
// Berry Agent SDK — Skill Types
// ============================================================

/** Parsed SKILL.md frontmatter metadata. */
export interface SkillMeta {
  /** Skill name (from frontmatter or directory name). */
  name: string;
  /** Short description for system prompt index. */
  description: string;
  /** When to use hint (CC-compatible). */
  whenToUse?: string;
  /** Semantic version. */
  version?: string;
  /** Tool names this skill is allowed to use. */
  allowedTools?: string[];
  /** Model override for this skill. */
  model?: string;
  /** Whether users can invoke this skill directly (default: true). */
  userInvocable?: boolean;
  /** File path patterns for conditional activation. */
  paths?: string[];
  /**
   * Provenance of this skill. Informational only — the SDK does not route
   * on this field; host products use it to decide how to surface the skill
   * in UIs and in the system-prompt index.
   *
   *   'global'    — installed into a host-wide shared pool
   *   'per-agent' — lives under a single agent's workspace; the agent
   *                 itself may be the author (self-distilled) or a human
   *                 may have hand-placed it. The distinction between
   *                 "who wrote it" is carried by `authorAgent`.
   */
  source?: 'global' | 'per-agent';
  /** When the skill was authored by an agent, the agent id. */
  authorAgent?: string;
  /** ISO-8601 date/time the skill was first authored or installed. */
  createdAt?: string;
}

/** A fully loaded skill (meta + content). */
export interface Skill {
  meta: SkillMeta;
  /** Full SKILL.md body (without frontmatter). Loaded lazily. */
  content: string;
  /** Absolute path to the skill directory. */
  dir: string;
  /** Absolute path to SKILL.md file. */
  filePath: string;
}

/** Skill reference in system prompt (lightweight, no full content). */
export interface SkillIndex {
  name: string;
  description: string;
  whenToUse?: string;
}

/**
 * A skills directory plus default provenance to stamp onto skills whose
 * frontmatter didn't declare it. Used by {@link AgentConfig.skillDirs} so
 * the host product can tag a whole pool (e.g. "this is the global pool" /
 * "this is agent X's private pool") without editing each SKILL.md.
 *
 * Explicit frontmatter always wins — defaults only fill in missing fields.
 */
export interface SkillDirSpec {
  /** Absolute or relative path to the skills directory. */
  dir: string;
  /** Source default for skills under this dir whose frontmatter omits it. */
  defaultSource?: SkillMeta['source'];
  /** authorAgent default for skills under this dir whose frontmatter omits it. */
  defaultAuthorAgent?: string;
}
