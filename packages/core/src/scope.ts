// ============================================================
// Berry Agent SDK — Agent Scope (Permission Fact Source)
// ============================================================
//
// AgentScope is the single source of truth for an agent's
// readable and writable path ranges. Everything else —
// ToolGuard, OS sandbox, file tools — reads from here.
//
// Principles:
//   - Read: limited to readableRoots
//   - Write: limited to writableRoots (workspace + project)
//   - Derived from agent config (workspace, project), not hardcoded
//   - Frontend can change project → scope updates automatically

import { isAbsolute, resolve, relative } from 'node:path';
import { realpathSync } from 'node:fs';

export class AgentScope {
  /** Agent 私有目录（MEMORY.md、sessions 等） */
  readonly workspace: string;
  /** 项目根目录（代码文件），可选 */
  readonly project: string | null;

  constructor(workspace: string, project?: string | null) {
    this.workspace = resolveReal(workspace);
    this.project = project ? resolveReal(project) : null;
  }

  /**
   * Convenience constructor from a single root string.
   * Used by simple integrations where workspace and project are the same path.
   */
  static fromRoot(root: string): AgentScope {
    return new AgentScope(root, root);
  }

  /**
   * Effective project directory (falls back to workspace).
   * This is the primary working directory for path resolution.
   */
  get projectDir(): string {
    return this.project ?? this.workspace;
  }

  /** 可读取的根目录列表 */
  get readableRoots(): string[] {
    return this.project
      ? [this.project, this.workspace]
      : [this.workspace];
  }

  /**
   * 可写入的根目录列表 — 唯一写入事实源.
   *
   * Includes:
   *   - project (if set) — code files
   *   - workspace — agent private data (MEMORY.md, etc.)
   */
  get writableRoots(): string[] {
    return this.project
      ? [this.project, this.workspace]
      : [this.workspace];
  }

  /**
   * Check whether a path is within the writable scope.
   * Resolves the path first, then checks against each writable root.
   */
  isWritable(path: string): boolean {
    const resolved = resolveReal(path);
    return this.writableRoots.some((root) => isWithinRoot(root, resolved));
  }

  /**
   * Check whether a path is within the readable scope.
   */
  isReadable(path: string): boolean {
    const resolved = resolveReal(path);
    return this.readableRoots.some((root) => isWithinRoot(root, resolved));
  }

  /**
   * String representation for debugging.
   */
  toString(): string {
    const parts = [`workspace=${this.workspace}`];
    if (this.project) parts.push(`project=${this.project}`);
    parts.push(`writable=[${this.writableRoots.join(', ')}]`);
    return `AgentScope(${parts.join(', ')})`;
  }
}

/**
 * Resolve a path to its real (non-symlink) absolute form.
 * Falls back to resolve() if the path doesn't exist yet.
 */
function resolveReal(p: string): string {
  try {
    return realpathSync(resolve(p));
  } catch {
    return resolve(p);
  }
}

function isWithinRoot(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}
