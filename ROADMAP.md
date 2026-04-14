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
- [x] Tool Guard (single function hook, pre-execution intercept)
- [x] Skills system (SKILL.md loader + index + load_skill tool)
- [x] Structured output (Anthropic virtual tool + OpenAI json_schema)
- [x] Multi-modal input (images)
- [x] Error recovery (classifyError + retry + onRetry + PTL auto-recovery)
- [x] Incremental session save (crash recovery)
- [x] **delegate/spawn as built-in tools** (LLM self-decides when to fork)
- [x] **Parallel tool execution** (Promise.all for independent tools)
- [x] **ProviderRegistry** (multi-provider management + model routing)
- [x] **Agent.create()** static factory (3 config styles)
- [x] **switchProvider()** — runtime model switching
- [x] **inspect()** — agent introspection
- [x] **Tool name constants** (single source of truth in tool-names.ts)
- [x] **AgentEventType / GuardEventKind** union types

### @berry-agent/tools-common (NEW)
- [x] read_file / write_file / list_files (scoped to baseDir)
- [x] edit_file (exact text replacement)
- [x] shell (with blocked commands)
- [x] grep / find_files
- [x] web_fetch (HTTP → markdown, node-html-markdown)
- [x] web_search (adapter pattern: Tavily / Brave / SerpAPI)
- [x] browser (Playwright: navigate / snapshot / screenshot / click / type / evaluate)
- [x] createAllTools() convenience (7 tools) + separate factories for web/browser

### @berry-agent/observe (NEW)
- [x] SQLite storage (Drizzle ORM, 6 tables)
- [x] Middleware collector (LLM calls + tool calls + full content)
- [x] Event collector (guard decisions, compaction events, session lifecycle)
- [x] 9 analyzer methods (cost, cache, guard, compaction, inference, session, agent)
- [x] REST server — createObserveRouter() (14 endpoints)
- [x] Standalone server — startObserveServer() (API + built-in UI)
- [x] React UI — 10 components (ObserveApp, InferenceDetail with Berry/Anthropic/OpenAI views)
- [x] Shared API types (api-types.ts, single source of truth for server ↔ UI)
- [x] OBSERVE_API_PATHS constants
- [x] Retention (auto-cleanup by age)
- [x] Built-in pricing table (6 models, overrideable)

### @berry-agent/mcp
- [x] MCPClient (stdio + HTTP transport)
- [x] createMCPTools() adapter (prefix/include/exclude)

### @berry-agent/safe
- [x] Pre-built guards: denyList, allowList, directoryScope, rateLimiter, compositeGuard
- [x] LLM Transcript Classifier (reasoning-blind, two-stage, backpressure)
- [x] PI Probe (pattern-based, middleware)
- [x] Audit logger (withAudit + memory/console sinks)

### Numbers
- **Source**: 7,825 lines (5 packages + UI)
- **Tests**: 183 (16 test files), all passing
- **npm**: @berry-agent/core, @berry-agent/mcp, @berry-agent/safe published (alpha)

---

## v0.2 (planned)

### @berry-agent/core
- [ ] Session as event log (append-only, getEvents/emitEvent)
- [ ] Agent lifecycle hooks (onBeforeQuery, onAfterQuery)
- [ ] Skill self-creation (agent writes new SKILL.md at runtime → L3+ on evolvability ladder)
- [ ] Context window management (selective retrieval, context engineering transforms)

### @berry-agent/safe
- [ ] Credential Isolation middleware (vault + transparent injection)
- [ ] Sub-agent handoff checks (outbound classifier at delegate, return check at result)
- [ ] Sandbox policy interface (network/filesystem/process declarations)

### @berry-agent/observe
- [ ] npm publish (@berry-agent/observe + UI build)
- [ ] OpenTelemetry export (spans)
- [ ] Session replay viewer

### @berry-agent/tools-common
- [ ] npm publish
- [ ] Tools extension packages (e.g., tools-ext-mac)

### @berry-agent/team (future)
- [ ] Multi-agent orchestration (task-based delegation)
- [ ] Inter-agent messaging (mailbox pattern)
- [ ] Role-based teams (lead + teammates)

---

## Decisions Log

### Confirmed
- **toolGuard** — single function hook (allow/deny/modify), pre-execution intercept
- **Skill trigger** — load_skill built-in tool (standard tool_use protocol)
- **delegate/spawn** — exposed as built-in tools so LLM can self-decide
- **Token budget** — not doing it (limiting agent is anti-pattern)
- **Observability** — dedicated @berry-agent/observe package (not in core)
- **Tool names** — centralized constants in tool-names.ts (no string scattering)
- **API types** — shared api-types.ts (single source of truth for server ↔ UI)
- **Parallel tool exec** — Promise.all by default (all tool calls in one turn run concurrently)
- **Browser** — Playwright (TS-native, multi-browser, headless, industry standard)
- **Web search** — adapter pattern, config-driven (Tavily/Brave/SerpAPI, no SDK-level API key)
- **LLM Classifier** — reasoning-blind (only user messages + tool calls, CC auto mode inspired)
- **PI Probe** — warn-not-block (re-anchor agent on user intent)

### Language choice
- TypeScript for harness/SDK layer (IO-bound, JSON-native, fast iteration)
- Rust for infrastructure layer (sandbox, containers) — not in this repo
- Python for ML pipeline — not in this repo
