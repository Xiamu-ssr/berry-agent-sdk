# Durability & Crash Recovery

**Status:** Implemented (v0.4).
**See also:** `V0.4-PLAN.md` for the internalization refactor.

## Goal

If the process running a Berry agent dies mid-turn — OOM kill, panic,
SIGKILL during a tool call — the next restart can resume the session
with *the exact same context the model saw*, plus a clear warning if any
tool call was interrupted.

## Architecture (one-paragraph summary)

Every session writes an **append-only event log** (`FileEventLogStore`,
jsonl on disk). The log is the source of truth; the in-memory message
list is a derived view. On `agent.query(prompt, { resume: sessionId })`,
the SDK rebuilds context by replaying the log through `ContextStrategy`,
detects any crash artifacts (orphaned `tool_use_start` without
`tool_use_end`), and — if found — appends a `crash_recovered` event and
injects a system warning to the next LLM call. Product code never sees
any of this; it just calls `new Agent + query` with a known session ID.

## Event log shape

Events are append-only with these types (non-exhaustive, see
`packages/core/src/event-log/types.ts`):

| Event | Purpose |
|:---|:---|
| `session_start` | Header: systemPrompt, model, toolsAvailable. Written exactly once. |
| `user_message` / `assistant_message` | Conversation turns. |
| `tool_use_start` / `tool_use_end` | Tool-call crash markers. Orphans = crash. |
| `messages_snapshot` | Written after compaction so replay does not need to redo it. |
| `compaction_marker` | Metadata about when compaction ran. |
| `query_start` / `query_end` | Per-query boundaries for observability. |
| `crash_recovered` | **New in v0.4.** Written when resume detects crash artifacts. Carries the full orphanedTools audit detail. |

With `session_start` at the head and `messages_snapshot` after each
compaction, replay can reconstruct any point-in-time context.

## Crash detection (v0.4 — internal to SDK)

On `query({ resume: sessionId })`:

1. `resolveSession()` reads the event log.
2. `detectCrashArtifacts()` (pure function in
   `event-log/crash-detector.ts`, the **single source of truth**) scans
   for `tool_use_start` events without matching `tool_use_end`.
3. If any orphans are found:
   - Append a `crash_recovered` event to the log.
   - `interject()` a warning message so the next LLM call sees:
     > ⚠️ [Berry SDK] Crash recovery: the following tool call(s) were
     > interrupted during execution on the previous run. Their side
     > effects are UNKNOWN (may have partially completed). Please
     > assess whether to retry, verify state, or proceed: …
   - Emit a `crash_recovered` AgentEvent for observability.
4. A per-process `_crashCheckedSessions` set guarantees this runs at
   most once per session per process (resuming the same session twice
   does not write duplicate audit events).

## Product-facing API

```ts
const agent = new Agent({
  provider: { type: 'anthropic', apiKey, model },
  systemPrompt,
  tools,
  eventLogStore: new FileEventLogStore(workspaceRoot),
  // ...
});

// First run
const { sessionId } = await agent.query('Hello', {});

// ... process crashes during a tool call ...

// After restart — a brand new Agent instance, same session id.
// The SDK detects the crash and warns the model internally; no
// special API call needed.
const freshAgent = new Agent({ /* same config */ });
await freshAgent.query('continue please', { resume: sessionId });
```

There is **no public `Agent.fromLog(…)`** — it existed in v1.5 but was
removed in v0.4 because crash recovery is infrastructure concern, not
product API.

## Observability

See `packages/observe`:

- `turns.recoveredFromCrash` / `turns.orphanedToolCount` /
  `turns.previousTurnId` — the turn that resumed after a crash is
  flagged at the SQL level.
- `agent_events[kind='crash_recovered']` — verbatim audit row with the
  full orphanedTools array.
- `MetricsCalculator.stabilityMetrics(agentId?)` — crash rate,
  totalOrphanedTools, top orphaned tool names.
- The Observe UI shows an amber banner on recovered `TurnDetail` pages
  and an inline icon in `TurnList`. No new tab was added — crash
  recovery is modeled as first-class turn metadata, not a side feature.

## Non-goals

- Transaction / rollback on failed turns.
- Multi-writer coordination on the same session file. Berry-Claw is
  single-process per session; cross-process coordination is a separate
  problem.

## Migration notes

Event logs written by older SDK versions remain readable:

- `ApiCallEvent` is retained as a narrow type alias for read-only
  backward compatibility (deprecated since v1.6).
- Pre-v1.4 logs without `session_start` now fall through to the
  legacy session-store path on resume.

---

*Last updated: 2026-04-22 (v0.4 crash-recovery internalization).*
