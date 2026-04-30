# Changelog

All notable changes to Berry Agent SDK. Packages ship independently; each
entry scopes its changes to a specific `@berry-agent/*` package + version.

## [@berry-agent/mcp 0.3.1-alpha.0] — 2026-04-29

### Fixed

- Sanitize upstream MCP tool names before forwarding to providers.
  Anthropic / OpenAI / Moonshot / OpenRouter enforce function names
  matching `^[a-zA-Z][a-zA-Z0-9_-]*$`. Servers that expose dotted or
  colon-separated names (e.g. `product-project.create_draft`) caused
  every inference with tools to fail with `invalid_request_error`.
  `createMCPTools` now rewrites disallowed characters to `_`, warns on
  rewrite, and detects sanitization collisions. Dispatch still uses the
  original upstream name, so MCP routing is unchanged.

### Changed

- `ToolRegistration.source` now carries `{ kind: 'mcp', server }`
  provenance so downstream UIs can attribute tools without re-parsing
  the `${prefix}name` convention.

## [@berry-agent/models 0.1.0-alpha.0] — 2026-04-29

### Added

- First publish. Unified model registry + provider tier resolution.

## [@berry-agent/team 0.1.0-alpha.0] — 2026-04-29

### Added

- First publish. Multi-agent team orchestration (worklist, roles, leader).

## [@berry-agent/memory-file, core, observe, safe, tools-common 0.4.0-alpha.1] — 2026-04-22

### Changed — Crash recovery is now SDK-internal

The public `Agent.fromLog(sessionId, ...)` API introduced in v1.5 has been
**removed**. Crash recovery is now transparent infrastructure: product code
calls `new Agent(config) + agent.query(prompt, { resume: sessionId })` and
the SDK detects orphaned tool calls, appends a `crash_recovered` audit
event, and injects a system warning for the LLM — all internally.

**Migration:** Replace `Agent.fromLog({...})` with `new Agent({...})`. If
you were relying on a session being bound to an agent, pass `resume:
sessionId` as a query option.

### Added

- **`@berry-agent/core`**
  - `event-log/constants.ts`: `TOOL_CALL_STATUS`, `CRASH_KIND`,
    `SDK_SYSTEM_WARNING_PREFIX` — single source of truth for enums.
  - `event-log/crash-detector.ts`: pure `detectCrashArtifacts()` +
    `formatCrashInterject()`. Agents, collectors, and analyzers all
    import from here. No duplicate logic.
  - `CrashRecoveredEvent` session event type (append-only audit).
  - `crash_recovered` `AgentEvent` type for live observers.

- **`@berry-agent/observe`**
  - `turns.recoveredFromCrash` / `turns.orphanedToolCount` /
    `turns.previousTurnId` columns (schema + idempotent migrations).
  - Collector consumes `crash_recovered` AgentEvent, stamps the next
    turn, and writes a verbatim `agent_events[kind='crash_recovered']`
    row with the full orphanedTools detail.
  - `MetricsCalculator.stabilityMetrics(agentId?)` returns
    `{ totalTurns, recoveredTurns, crashRate, totalOrphanedTools,
      topOrphanedTools }`.

- **`@berry-agent/observe/ui`**
  - `TurnDetail`: amber "Crash recovery turn" banner on recovered turns.
  - `TurnList`: inline `AlertTriangle` icon with orphan count tooltip.
  - No new tab / page — crash recovery is first-class turn metadata.

### Removed

- `Agent.fromLog(...)` — use `new Agent + query({ resume })` instead.
- `_pendingResumeSessionId` internal hack (no longer needed).

### Docs

- `docs/DURABILITY.md` rewritten to describe the v0.4 design (English).
- `docs/DURABILITY.zh.md` aligned with EN.

---

## [0.3.x] — prior

See git history. v1.4 introduced the event log; v1.5 added the
(now-removed) `Agent.fromLog` API; v1.6 deleted legacy `api_call`
writes.
