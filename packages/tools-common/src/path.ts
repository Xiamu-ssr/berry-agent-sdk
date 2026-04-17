// ============================================================
// Berry Agent SDK — Common Tools: Path Helpers
// ============================================================

import { isAbsolute, relative, resolve } from 'node:path';

/**
 * Resolve a user-supplied path relative to baseDir and ensure it stays within scope.
 */
export function resolveScopedPath(baseDir: string, inputPath: string): string {
  const base = resolve(baseDir);
  const target = resolve(base, inputPath);
  const rel = relative(base, target);

  if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) {
    return target;
  }

  throw new Error('Path escapes base directory');
}

/**
 * Resolve a path for shell-based tools, returning a baseDir-relative path when possible.
 */
export function resolveScopedRelativePath(baseDir: string, inputPath: string): string {
  const base = resolve(baseDir);
  const target = resolveScopedPath(base, inputPath);
  const rel = relative(base, target);
  return rel === '' ? '.' : rel;
}

/**
 * Minimal POSIX shell escaping via single quotes.
 */
export function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
