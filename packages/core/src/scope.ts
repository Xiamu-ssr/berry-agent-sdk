// ============================================================
// Berry Agent SDK — Agent Scope (Permission Fact Source)
// ============================================================
//
// AgentScope is the single source of truth for an agent's
// readable and writable path ranges. Everything else —
// ToolGuard, OS sandbox, file tools — reads from here.
//
// Principles:
//   - Read: unrestricted (isReadable always returns true)
//   - Write: limited to writableRoots (workspace + project + /tmp)
//   - Derived from agent config (workspace, project), not hardcoded
//   - Frontend can change project → scope updates automatically

import { resolve, relative } from 'node:path';
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
   * Used for backward compatibility where only projectRoot is known.
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

  /** 可读取的根目录列表 (currently informational — reads are unrestricted) */
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
    const resolved = resolve(path);
    return this.writableRoots.some((root) => {
      const rel = relative(root, resolved);
      return !rel.startsWith('..') && !rel.startsWith('/');
    });
  }

  /**
   * Check whether a path is within the readable scope.
   * Currently always returns true (reads are unrestricted).
   */
  isReadable(_path: string): boolean {
    return true;
  }

  /**
   * Generate a SandboxConfig for the OS-level sandbox.
   * Consumed by @berry-agent/safe's createSandbox().
   *
   * Note: Returns a plain object matching SandboxConfig's shape,
   * but doesn't import the type directly to avoid circular deps.
   * The consumer (agent-manager) casts as needed.
   */
  toSandboxConfig(): {
    allowRead: string[];
    allowWrite: string[];
    network: 'allow' | 'deny' | { allowDomains: string[] };
    allowExec: boolean;
  } {
    return {
      allowRead: ['/'],
      allowWrite: [...this.writableRoots, '/tmp'],
      network: 'allow',
      allowExec: true,
    };
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