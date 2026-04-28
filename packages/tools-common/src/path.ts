// ============================================================
// Berry Agent SDK — Common Tools: Path Helpers
// ============================================================

import { isAbsolute, relative, resolve } from 'node:path';

/**
 * Resolve a user-supplied path relative to baseDir and ensure it stays within scope.
 * (Legacy single-root scoping — kept for backward compatibility.)
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
 * (Legacy single-root scoping — kept for backward compatibility.)
 */
export function resolveScopedRelativePath(baseDir: string, inputPath: string): string {
  const base = resolve(baseDir);
  const target = resolveScopedPath(base, inputPath);
  const rel = relative(base, target);
  return rel === '' ? '.' : rel;
}

/**
 * Resolve a path in Claude Code style:
 * - `//abs/path` → absolute path (strip the leading / convention, keep /abs/path)
 * - `/rel/path`  → relative to projectRoot
 * - `rel/path`   → relative to cwd
 *
 * Then verify it stays within projectRoot.
 */
export function resolveClaudeCodePath(
  projectRoot: string,
  cwd: string,
  inputPath: string,
): string {
  const root = resolve(projectRoot);
  const cwdResolved = resolve(cwd);
  let target: string;

  if (inputPath.startsWith('//')) {
    // Absolute path: strip the leading // convention, keep the absolute /
    // e.g. "//Users/foo/bar" → "/Users/foo/bar"
    target = resolve(inputPath.slice(1));
  } else if (inputPath.startsWith('/')) {
    // Relative to project root (strip leading /)
    target = resolve(root, inputPath.slice(1));
  } else {
    // Relative to current working directory
    target = resolve(cwdResolved, inputPath);
  }

  // Security: must stay within projectRoot
  const rel = relative(root, target);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error('Path escapes project directory');
  }

  return target;
}

/**
 * Resolve a path in Claude Code style and return a path relative to projectRoot
 * (useful for shell commands that run with cwd = projectRoot).
 */
export function resolveClaudeCodeRelativePath(
  projectRoot: string,
  cwd: string,
  inputPath: string,
): string {
  const abs = resolveClaudeCodePath(projectRoot, cwd, inputPath);
  const rel = relative(resolve(projectRoot), abs);
  return rel === '' ? '.' : rel;
}

/**
 * Minimal POSIX shell escaping via single quotes.
 */
export function shellEscape(value: string): string {
  return '\'' + value.replace(/'/g, "'\\''") + '\'';
}
