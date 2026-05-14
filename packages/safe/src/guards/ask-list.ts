// ============================================================
// Human-in-the-loop (HITL) approval guard
// ============================================================
// When a matched tool call arrives, pause execution and ask a human
// (via the injected `ask` bridge) whether to allow it. The bridge is
// application-supplied — typically in a web product it pushes a
// question through an event bus, waits for an approval endpoint to
// fire, and resolves the returned Promise.
//
// The guard itself is transport-agnostic: any `(question) => Promise<answer>`
// works. Timeouts default to "deny" to keep agents from stalling forever
// when the UI disappears.

import type { ToolGuard } from '@berry-agent/core';

/** Question passed to the application-supplied approval bridge. */
export interface AskQuestion {
  /** Tool name being called. */
  toolName: string;
  /** Arguments the agent wants to pass. */
  input: Record<string, unknown>;
  /** Session this call belongs to (id/cwd/model). */
  session: { id: string; cwd: string; model: string };
  /** Sequential index within the current query. */
  callIndex: number;
  /** Human-readable reason the guard is requesting approval. */
  reason: string;
}

/** Application's answer to an approval question. */
export interface AskAnswer {
  /** true = let the call proceed, false = block it. */
  approved: boolean;
  /** Optional free-text from the human — surfaced in the deny reason. */
  note?: string;
}

/** Bridge function: `(question) => Promise<answer>`. */
export type AskBridge = (question: AskQuestion) => Promise<AskAnswer>;

export interface AskListOptions {
  /**
   * Tool names that must be approved. Everything else is allowed
   * through untouched. Matched by exact name — wildcards not supported
   * (composite with an `allowList` / custom guard if you need patterns).
   */
  tools: string[];
  /**
   * Application-supplied approval bridge. The guard calls this whenever
   * a matched tool is dispatched and waits for the returned Promise.
   * If omitted, every matched call is auto-denied — the guard refuses
   * to fail open when there's no human to ask.
   */
  ask?: AskBridge;
  /**
   * Max ms to wait for an answer before auto-denying (default: 5 min).
   * Set 0 to wait indefinitely (not recommended — the agent run blocks
   * until the UI comes back).
   */
  timeoutMs?: number;
  /**
   * Human-readable reason passed to the bridge. Shown to the user in
   * the approval UI so they know which guard asked. Default: "HITL
   * approval required".
   */
  reason?: string;
}

/**
 * Human-in-the-loop approval guard. Blocks execution on listed tools
 * until an approval bridge answers.
 */
export function askList(options: AskListOptions): ToolGuard {
  const matched = new Set(options.tools);
  const timeoutMs = options.timeoutMs ?? 5 * 60_000;
  const reason = options.reason ?? 'HITL approval required';
  const ask = options.ask;

  return async ({ toolName, input, session, callIndex }) => {
    if (!matched.has(toolName)) return { action: 'allow' };

    // No bridge installed → fail-closed. Installing the bridge is a
    // deliberate host-product step; defaulting to allow would silently
    // neuter the safety mode.
    if (!ask) {
      return {
        action: 'deny',
        reason: `${reason} (no approval bridge installed; tool "${toolName}" blocked by default)`,
      };
    }

    const question: AskQuestion = { toolName, input, session, callIndex, reason };
    try {
      const answer = await withTimeout(ask(question), timeoutMs);
      if (answer.approved) return { action: 'allow' };
      const suffix = answer.note ? `: ${answer.note}` : '';
      return { action: 'deny', reason: `Denied by human approver${suffix}` };
    } catch (err) {
      // Timeout or bridge error — treat as deny so the agent reports back
      // to the user rather than silently running an unreviewed call.
      const msg = err instanceof Error ? err.message : String(err);
      return { action: 'deny', reason: `Approval bridge failed: ${msg}` };
    }
  };
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  if (ms <= 0) return p;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}
