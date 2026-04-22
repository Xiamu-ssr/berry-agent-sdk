// ============================================================
// Berry Agent SDK — Event Log: Crash Detector
// ============================================================
// Pure, side-effect-free functions for detecting crash artifacts
// in an event log. This is the SINGLE SOURCE OF TRUTH for what
// counts as a "crash" — the agent, collector, and any analyzer
// must call these helpers instead of re-implementing the logic.

import type { SessionEvent } from './types.js';
import { CRASH_KIND, type CrashKind } from './constants.js';

/** Info about a tool call that started but never completed. */
export interface OrphanedToolInfo {
  kind: typeof CRASH_KIND.ORPHANED_TOOL;
  toolUseId: string;
  name: string;
  input: Record<string, unknown>;
  /** Timestamp when tool_use_start was recorded. */
  startedAt: number;
  /** Event ID of the tool_use_start for audit linkage. */
  startEventId: string;
}

/** Result of scanning an event log for crash artifacts. */
export interface CrashDetectionResult {
  /** Any crash artifacts found. Empty array = no crash. */
  artifacts: OrphanedToolInfo[];
  /** True iff artifacts.length > 0. Convenience flag. */
  crashed: boolean;
  /** Counts by crash kind, for quick stats. */
  counts: Record<CrashKind, number>;
}

/**
 * Scan an event log for crash artifacts.
 *
 * Current detection: tool_use_start without matching tool_use_end.
 * Future kinds should be added here (e.g., api_request without api_response).
 *
 * @param events  Events from an EventLogStore (assumed ordered by timestamp).
 * @returns       Detection result. Always defined; `.crashed` is false if clean.
 */
export function detectCrashArtifacts(events: readonly SessionEvent[]): CrashDetectionResult {
  const toolStarts = new Map<string, OrphanedToolInfo>();
  const finishedIds = new Set<string>();

  for (const ev of events) {
    if (ev.type === 'tool_use_start') {
      toolStarts.set(ev.toolUseId, {
        kind: CRASH_KIND.ORPHANED_TOOL,
        toolUseId: ev.toolUseId,
        name: ev.name,
        input: ev.input,
        startedAt: ev.timestamp,
        startEventId: ev.id,
      });
    } else if (ev.type === 'tool_use_end') {
      finishedIds.add(ev.toolUseId);
    }
  }

  const artifacts: OrphanedToolInfo[] = [];
  for (const [id, info] of toolStarts) {
    if (!finishedIds.has(id)) artifacts.push(info);
  }

  const counts: Record<CrashKind, number> = {
    [CRASH_KIND.ORPHANED_TOOL]: artifacts.filter(a => a.kind === CRASH_KIND.ORPHANED_TOOL).length,
  };

  return {
    artifacts,
    crashed: artifacts.length > 0,
    counts,
  };
}

/**
 * Build the user-facing interject message for detected crash artifacts.
 * Kept here so the exact wording is defined once.
 */
export function formatCrashInterject(artifacts: readonly OrphanedToolInfo[]): string {
  if (artifacts.length === 0) return '';

  const lines = artifacts.map(a => {
    const inputPreview = JSON.stringify(a.input).slice(0, 120);
    return `• ${a.name}(id=${a.toolUseId}, input=${inputPreview})`;
  });

  return (
    `⚠️ [Berry SDK] Crash recovery: the following tool call(s) were interrupted ` +
    `during execution on the previous run. Their side effects are UNKNOWN (may have ` +
    `partially completed). Please assess whether to retry, verify state, or proceed:\n\n` +
    lines.join('\n')
  );
}
