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
