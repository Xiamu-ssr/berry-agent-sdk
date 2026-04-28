// ============================================================
// Pre-built rule-based guards (Tier 0 — zero LLM cost)
// ============================================================

import type { ToolGuard, ToolGuardDecision, AgentScope } from '@berry-agent/core';
import { resolve, relative } from 'node:path';

/**
 * Deny tool calls matching any pattern in the list.
 * Patterns are matched against tool name or serialized input.
 */
export function denyList(patterns: string[]): ToolGuard {
  return async ({ toolName, input }) => {
    const serialized = `${toolName} ${JSON.stringify(input)}`;
    for (const pattern of patterns) {
      if (serialized.includes(pattern)) {
        return { action: 'deny', reason: `Blocked by deny list: "${pattern}"` };
      }
    }
    return { action: 'allow' };
  };
}

/**
 * Only allow tool calls whose name is in the list.
 * Everything else is denied.
 */
export function allowList(allowed: string[]): ToolGuard {
  const set = new Set(allowed);
  return async ({ toolName }) => {
    if (set.has(toolName)) return { action: 'allow' };
    return { action: 'deny', reason: `Tool "${toolName}" not in allow list` };
  };
}

/**
 * Restrict file operations to a specific directory.
 * Checks 'path', 'file', 'filename', 'dir', 'directory' fields in input.
 */
export function directoryScope(allowedDir: string): ToolGuard {
  const resolved = resolve(allowedDir);
  const pathFields = ['path', 'file', 'filename', 'dir', 'directory', 'target'];

  return async ({ input }) => {
    for (const field of pathFields) {
      const value = input[field];
      if (typeof value === 'string') {
        // Resolve relative paths against allowedDir, not process.cwd().
        // Without this, path "." resolves to cwd and gets denied.
        const abs = resolve(resolved, value);
        const rel = relative(resolved, abs);
        if (rel.startsWith('..')) {
          return { action: 'deny', reason: `Path "${value}" is outside allowed directory "${allowedDir}"` };
        }
      }
    }
    return { action: 'allow' };
  };
}

/**
 * Rate limiter: deny if too many tool calls in a time window.
 */
export function rateLimiter(opts: {
  maxCalls: number;
  windowMs?: number;
}): ToolGuard {
  const windowMs = opts.windowMs ?? 60_000;
  const timestamps: number[] = [];

  return async () => {
    const now = Date.now();
    // Remove expired timestamps
    while (timestamps.length > 0 && timestamps[0]! < now - windowMs) {
      timestamps.shift();
    }
    if (timestamps.length >= opts.maxCalls) {
      return { action: 'deny', reason: `Rate limit exceeded: ${opts.maxCalls} calls per ${windowMs}ms` };
    }
    timestamps.push(now);
    return { action: 'allow' };
  };
}

/**
 * Compose multiple guards. First deny wins. First modify wins.
 * All must allow for the action to proceed.
 */
export function compositeGuard(...guards: ToolGuard[]): ToolGuard {
  return async (ctx) => {
    let modified: ToolGuardDecision | null = null;
    for (const guard of guards) {
      const decision = await guard(ctx);
      if (decision.action === 'deny') return decision;
      if (decision.action === 'modify' && !modified) {
        modified = decision;
      }
    }
    return modified ?? { action: 'allow' };
  };
}

/**
 * Write scope guard: restricts write_file and edit_file to paths
 * within the agent's writable scope. Read operations are not restricted.
 *
 * Uses AgentScope as the single source of truth for writable paths.
 * Shell commands are NOT checked here — OS-level sandbox handles them.
 */
export function writeScopeGuard(scope: AgentScope): ToolGuard {
  const writeTools = new Set(['write_file', 'edit_file']);
  const pathFields = ['path', 'file', 'filename'];

  return async ({ toolName, input }) => {
    if (!writeTools.has(toolName)) return { action: 'allow' };

    for (const field of pathFields) {
      const value = input[field];
      if (typeof value !== 'string') continue;

      // Resolve using projectDir as base (matches CC-style path resolution)
      const resolved = resolve(scope.projectDir, value);
      if (!scope.isWritable(resolved)) {
        return {
          action: 'deny',
          reason: `Path "${value}" resolves to "${resolved}", which is outside writable scope. Writable: ${scope.writableRoots.join(', ')}`,
        };
      }
    }
    return { action: 'allow' };
  };
}
