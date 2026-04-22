// ============================================================
// Berry Agent SDK — Event Log: Constants (single source of truth)
// ============================================================
// Shared enums/constants for event log + observe collector + UI.
// IMPORTANT: When adding a new enum value, update this file FIRST.
// Observe schema and UI must import from here — never redefine locally.

/** Status of a tool call as recorded in the observability layer.
 *  - completed: executed to the end (result captured, may or may not be error)
 *  - error:     executed but returned isError=true
 *  - orphaned:  started but never finished (process crashed during execution)
 */
export const TOOL_CALL_STATUS = {
  COMPLETED: 'completed',
  ERROR: 'error',
  ORPHANED: 'orphaned',
} as const;

export type ToolCallStatus = typeof TOOL_CALL_STATUS[keyof typeof TOOL_CALL_STATUS];

export const TOOL_CALL_STATUS_VALUES: readonly ToolCallStatus[] = Object.freeze([
  TOOL_CALL_STATUS.COMPLETED,
  TOOL_CALL_STATUS.ERROR,
  TOOL_CALL_STATUS.ORPHANED,
]);

/** Prefix used for all SDK-generated system warnings injected via interject().
 *  Shared so collectors/UI can reliably filter them.
 */
export const SDK_SYSTEM_WARNING_PREFIX = '⚠️ [Berry SDK]';

/** Types of crash events the SDK detects and records. */
export const CRASH_KIND = {
  /** Tool started but never finished (process died mid-execution). */
  ORPHANED_TOOL: 'orphaned_tool',
} as const;

export type CrashKind = typeof CRASH_KIND[keyof typeof CRASH_KIND];
