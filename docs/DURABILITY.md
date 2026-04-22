# Berry Agent SDK — Durability Design

Status: **draft, pending lanxuan review 2026-04-22**

## The problem (2026-04-22)

When a berry-claw process dies mid-turn, we can recover *some* agent state
but not all of it. This doc inventories what's persisted today, where the
gaps are, and what we should change to reach "kill -9 safe" durability.

## What berry-claw/SDK persists today

| Item | File | When written | Recoverable? |
|------|------|------------|:---:|
| Agent config (id, name, model spec, systemPrompt, project, tools, disabledTools) | `~/.berry-claw/config.json` | on every PUT/PATCH | ✅ |
| Per-agent working dir (AGENT.md, MEMORY.md, free files) | `~/.berry-claw/agents/<id>/` | agent-written | ✅ |
| Agent session event log | `~/.berry-claw/agents/<id>/.berry/sessions/ses_*.jsonl` | append on every event | ⚠️ partial |
| Team state | `<project>/.berry/team.json` | atomic rewrite | ✅ |
| Team inter-agent messages | `<project>/.berry/messages.jsonl` | append-only | ✅ |
| Worklist | `<project>/.berry/worklist.json` | atomic rewrite | ✅ |

## What the SDK event log currently captures

One line per event, each with `{id, timestamp, sessionId, turnId, type, ...payload}`.
Observed event types:

- `query_start` — prompt string
- `user_message` — user turn content
- `assistant_message` — model turn text content
- `text` — streaming delta
- `tool_use` — tool invocation (name + args)
- `tool_result` — tool output
- `guard_decision` — allow/deny from toolGuard
- `api_call` — model id + inputTokens + outputTokens (NO request body)
- `query_end` — turn terminator

## Gaps (what's NOT persisted)

### 1. System prompt is not in the session log

System prompts live in `config.json` only. If an agent's config is edited
mid-session, the session log doesn't record which system prompt was used
for a given turn. On restart we'd reload the *current* system prompt from
config, not the one active when the turn started.

### 2. The actual `messages[]` sent to the LLM is not stored

The SDK builds `messages[]` fresh on every turn from event log + any
in-memory context window state. This works for new turns, but:

- **Compaction** collapses old turns into summaries. The summary is in
  memory only. On restart we lose the summary and have to replay all
  raw events — wasteful and potentially different (different model run).
- **Middleware injections** (tools-common, toolGuard output) can shape
  the final messages. None of that shaping is visible from the log.

### 3. `api_call` events strip request body

We record tokens in/out but not the request itself. For debugging and
for true replay we need the full request body (messages + tools +
provider config) at minimum for the last successful api_call.

### 4. Running tool calls have no crash marker

If the process dies while a tool is executing, on restart the agent
doesn't know "tool X was halfway through"; it sees `tool_use` but no
matching `tool_result`. Current behavior: the next query just proceeds,
and the half-done tool effect (file written? network call made?) is
indeterminate.

## Proposed plan

### Phase 1 — Record everything we need for warm restart

Add 3 new event types, all written synchronously before their side
effects kick in:

```
session_start   { systemPrompt, projectContextSnapshot, toolsAvailable,
                  guardConfig, compactionConfig, providerBinding }
messages_snapshot  { messages: MessageParam[], reason: "compact" | "turn_start" }
api_request   { request: { model, messages, tools, params }, requestId }
api_response  { requestId, response: { stopReason, content, usage } }
tool_use_start { toolUseId, tool, input }    // already exists as tool_use
tool_use_end   { toolUseId, output, error }  // already exists as tool_result
```

With `session_start` present at every session's head and `messages_snapshot`
written right after each compaction, we can reconstruct the exact
context the LLM will see on the next turn, post-crash.

### Phase 2 — Expose a `rehydrateAgentFromLog()` helper in core

```ts
Agent.fromLog(sessionId, { provider, sessionStore }): Promise<Agent>
```

Reads the jsonl, finds the most recent `messages_snapshot`, replays any
events after that to reach current state, returns an Agent ready to
accept the next turn.

### Phase 3 — Crash markers for tool calls

Write `tool_use_start` before invoking tool, `tool_use_end` after.
On load, if a `tool_use_start` has no matching end, surface it as a
system message on the next turn ("Tool X was interrupted; do you want
to retry?") — same pattern as Codex.

### Non-goals (out of scope for this design)

- Transaction / rollback on failed turns. Too complex, not needed yet.
- Multi-writer coordination on the same session file. Berry-Claw is
  single-process; cross-machine is a different problem.

## Migration

Existing session logs are valid; new event types append. Reader code
tolerates unknown types (ignores them). Warm-restart capability arrives
gradually as new events start being written.

---

*Next: lanxuan decides the event shape, then we implement Phase 1.*
