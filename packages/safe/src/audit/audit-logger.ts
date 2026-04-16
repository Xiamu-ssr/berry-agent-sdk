// ============================================================
// Audit Logger — Records all guard evaluations
// ============================================================

import type { Middleware, ToolGuard } from '@berry-agent/core';
import type { AuditEntry, AuditSink } from '../types.js';

/**
 * Wrap a ToolGuard with audit logging.
 * Every guard evaluation (allow/deny/modify) is recorded.
 */
export function withAudit(guard: ToolGuard, sink: AuditSink): ToolGuard {
  return async (ctx) => {
    const start = Date.now();
    const decision = await guard(ctx);
    const entry: AuditEntry = {
      timestamp: start,
      toolName: ctx.toolName,
      input: ctx.input,
      decision: decision.action,
      reason: decision.action === 'deny' ? decision.reason : undefined,
      guardType: 'rule', // default; classifier wraps override this
      latencyMs: Date.now() - start,
    };
    await sink(entry);
    return decision;
  };
}

/**
 * Create an in-memory audit log sink.
 * Useful for testing and short-lived sessions.
 */
export function createMemoryAuditSink(): { sink: AuditSink; entries: AuditEntry[] } {
  const entries: AuditEntry[] = [];
  const sink: AuditSink = (entry) => { entries.push(entry); };
  return { sink, entries };
}

/**
 * Create a console audit sink (for development).
 */
export function createConsoleAuditSink(): AuditSink {
  return (entry) => {
    const icon = entry.decision === 'allow' ? '✅' : entry.decision === 'deny' ? '🚫' : '✏️';
    console.log(
      `${icon} [${new Date(entry.timestamp).toISOString()}] ${entry.toolName} → ${entry.decision}` +
      (entry.reason ? ` (${entry.reason})` : '') +
      ` [${entry.guardType}, ${entry.latencyMs}ms]`
    );
  };
}
