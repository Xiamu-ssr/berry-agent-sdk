# Berry Agent SDK — Roadmap

## v0.1 (current) ✅

### @berry-agent/core
- [x] Agent loop with tool calling
- [x] Anthropic provider (prompt cache, streaming)
- [x] OpenAI-compatible provider
- [x] 7-layer compaction pipeline + forked compact
- [x] Session persistence (FileSessionStore)
- [x] delegate() — one-shot fork with cache sharing
- [x] spawn() — persistent sub-agent
- [x] Middleware pipeline (onBefore/AfterApiCall, onBefore/AfterToolExec)
- [x] Tool Guard (single function hook)
- [x] Skills system (SKILL.md loader + index + load_skill tool)
- [x] Structured output (Anthropic virtual tool + OpenAI json_schema)
- [x] Multi-modal input (images)
- [x] Error recovery (classifyError + retry + onRetry + PTL auto-recovery)
- [x] Incremental session save (crash recovery)

### @berry-agent/mcp
- [x] MCPClient (stdio + HTTP transport)
- [x] createMCPTools() adapter (prefix/include/exclude)
- [ ] npm publish

### @berry-agent/safe
- [x] Pre-built guards: denyList, allowList, directoryScope, rateLimiter, compositeGuard
- [x] LLM Transcript Classifier (reasoning-blind, two-stage, backpressure)
- [x] PI Probe (pattern-based, middleware)
- [x] Audit logger (withAudit + memory/console sinks)
- [ ] npm publish

---

## v0.2 (planned)

### @berry-agent/core enhancements
- [ ] Session as event log (append-only, getEvents/emitEvent interface)
  - Inspired by Anthropic Managed Agents: session ≠ context window
  - Enables: replay, selective context retrieval, non-destructive compaction
- [ ] SessionStore interface expansion (appendEvent, getEvents)
- [ ] Agent lifecycle hooks (onBeforeQuery, onAfterQuery)
  - Needed by team package for multi-agent coordination
- [ ] Provider interface composability
  - Allow external packages (safe, observe) to use providers independently
- [ ] Context window management enhancement
  - getEvents(from, to) for selective context retrieval
  - Context engineering transforms in harness layer

### @berry-agent/safe enhancements
- [ ] Credential Isolation middleware (vault + transparent injection via onBeforeToolExec)
- [ ] Sub-agent handoff checks (outbound classifier at delegate, return check at result)
- [ ] Sandbox policy interface (network/filesystem/process declarations)
- [ ] LLM classifier with full transcript context (messages from ToolGuardContext)

### @berry-agent/observe (new package)
- [ ] Tracing middleware (span-based, OpenTelemetry-compatible)
- [ ] Cost tracking (usage → cost mapping, configurable price table)
- [ ] Metrics export (Prometheus/StatsD)
- [ ] Session replay viewer

### @berry-agent/team (new package)
- [ ] Multi-agent orchestration
- [ ] Task-based delegation (create/assign/claim/complete)
- [ ] Inter-agent messaging (mailbox pattern, inspired by CC Agent Teams)
- [ ] Role-based teams (lead + teammates, model differentiation)
- [ ] Built on top of core's spawn()

---

## Decisions log

### Confirmed
- **toolGuard** is a single function hook, not a mode (allow_all/supervised). Consumer implements.
- **Skill trigger** via `load_skill` built-in tool (standard tool_use protocol, zero magic)
- **Token budget** — not doing it (limiting agent is anti-pattern)
- **Observability** — not in core (onEvent + middleware sufficient; tracing goes to observe package)
- **Cost tracking** — SDK records usage only, doesn't calculate cost
- **delegate** = CC's `runForkedAgent` (one-shot fork + cache sharing)
- **spawn** = persistent sub-agent (Berry extension, CC doesn't have this)
- **team** = future package, based on CC Agent Teams architecture
- **LLM Classifier** = reasoning-blind (only user messages + tool calls, inspired by CC auto mode)
- **PI Probe** = warn-not-block (re-anchor agent on user intent)

### Language choice
- TypeScript for harness/SDK layer (IO-bound, JSON-native, fast iteration)
- Rust for infrastructure layer (sandbox, containers) — not in this repo
- Python for ML pipeline — not in this repo
