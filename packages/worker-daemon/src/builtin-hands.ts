// ============================================================
// @berry-agent/worker-daemon — built-in Hand selection from labels
// ============================================================
// Built-in Hand assembly rides the same mechanism as every other Hand
// concern (machines / team / role): agent labels. `labels.hands` is a comma
// list of built-in hand ids to enable. Keeping this in one tiny pure module
// makes it unit-testable (cli.ts is a bin with top-level side effects) and
// keeps the selection rule in one place.

/** Built-in hand ids the worker can assemble from `labels.hands`. */
export interface BuiltinHandSelection {
  /** file / shell / search, bound to the agent's execution environment. */
  workspace: boolean;
  /** web_fetch / web_search — env-less. */
  web: boolean;
}

/**
 * Select built-in Hands from an explicit id list. `undefined` → both on (the
 * historical default, so agents predating persisted Hand selection are
 * unaffected). This is the canonical selector; `parseBuiltinHands` is the
 * comma-string adapter for the `labels.hands` wire form.
 */
export function selectBuiltinHands(ids: string[] | undefined): BuiltinHandSelection {
  if (ids === undefined) return { workspace: true, web: true };
  const set = new Set(ids.map((s) => s.trim()).filter(Boolean));
  return { workspace: set.has('workspace'), web: set.has('web') };
}

/**
 * Parse `labels.hands` into on/off flags. Absent label → both on (the
 * historical default, so existing agents are unaffected). Recognized ids:
 * `workspace`, `web`. Unknown ids are ignored here — machine hands are
 * selected via `labels.machines`, not this label.
 */
export function parseBuiltinHands(raw: string | undefined): BuiltinHandSelection {
  if (raw === undefined) return { workspace: true, web: true };
  return selectBuiltinHands(raw.split(','));
}

/** The built-in hand ids that are enabled, as a stable sorted list — the
 *  form persisted to agent.json (`hands.builtin`). */
export function builtinHandsToIds(sel: BuiltinHandSelection): string[] {
  const ids: string[] = [];
  if (sel.workspace) ids.push('workspace');
  if (sel.web) ids.push('web');
  return ids;
}
