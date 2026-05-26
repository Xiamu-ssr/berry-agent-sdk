// ============================================================
// @berry-agent/safe — Project-level Safety Config
// ============================================================

import { dirname } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { projectSharedPaths } from '@berry-agent/core';
import { z } from 'zod';
import { asSafetyLevel, SAFETY_LEVELS, type SafetyLevel } from './levels.js';
export { SAFETY_LEVELS, asSafetyLevel } from './levels.js';
export type { SafetyLevel } from './levels.js';

export const zProjectSafetyConfig = z.object({
  level: z.enum(SAFETY_LEVELS).optional(),
}).passthrough();

export type ProjectSafetyConfig = z.infer<typeof zProjectSafetyConfig>;

/** Path to the SDK-managed project-level safety config. */
export function projectSafetyPath(projectRoot: string): string {
  return projectSharedPaths(projectRoot).safetyPath;
}

/**
 * Read `{projectRoot}/.berry/safety.json` synchronously. Returns `null`
 * when the file doesn't exist or is not parseable; callers treat that as
 * "no project override".
 */
export function readProjectSafety(projectRoot: string): ProjectSafetyConfig | null {
  const path = projectSafetyPath(projectRoot);
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, 'utf-8');
    return parseProjectSafetyConfig(JSON.parse(raw));
  } catch (err) {
    console.warn(
      `[safety] failed to parse ${path}:`,
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

/**
 * Write the project-level safety setting. `null` clears only `level` while
 * preserving any future fields in the same file.
 */
export function writeProjectSafety(projectRoot: string, level: SafetyLevel | null): void {
  const path = projectSafetyPath(projectRoot);
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const existing = readProjectSafety(projectRoot) ?? {};
  const next = { ...existing };
  if (level === null) delete next.level;
  else next.level = level;
  writeFileSync(path, JSON.stringify(next, null, 2) + '\n', 'utf-8');
}

/**
 * Resolve the effective safety level from plain values. Host products own
 * where their agent/global values live; the SDK owns project file semantics.
 */
export function resolveSafetyLevel(
  agentSafetyLevel: unknown,
  projectRoot: string | undefined,
  globalSafetyLevel: unknown,
): SafetyLevel {
  const agentLevel = asSafetyLevel(agentSafetyLevel);
  if (agentLevel) return agentLevel;

  if (projectRoot) {
    const projectLevel = asSafetyLevel(readProjectSafety(projectRoot)?.level);
    if (projectLevel) return projectLevel;
  }

  const globalLevel = asSafetyLevel(globalSafetyLevel);
  return globalLevel ?? 'default';
}

function parseProjectSafetyConfig(value: unknown): ProjectSafetyConfig {
  return zProjectSafetyConfig.parse(value);
}
