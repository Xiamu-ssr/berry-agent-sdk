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

## v0.2 ✅

### @berry-agent/core
- [x] Stream wire format fix (anthropic.ts + openai.ts include rawRequest/rawResponse)
- [x] delegate FK crash fix (sessionId generated outside loop)
- [x] observe middleware input pollution fix (WeakMap instead of __observeKey)
- [x] spawn sessionStore inheritance

### @berry-agent/observe
- [x] **Turn dimension** — turns table, turnId FK on llm_calls/tool_calls/guard_decisions
- [x] **createCollector()** unified factory (shared turnId state between middleware + eventListener)
- [x] **Multi-dimension analyzer** — DimensionFilter { sessionId?, agentId?, turnId? }
- [x] New methods: turnList(), turnSummary(), guardStatsByTool(), agentDetail()
- [x] inferenceList() gains model/since/until filters
- [x] **New API endpoints**: /turns, /turns/:id, /turns/:id/inferences, /guard/by-tool, /agents/:id, /agents/:id/sessions
- [x] **New UI components**: MiniStats, TurnList, TurnDetail, SessionDetail, AgentDetail
- [x] **Enhanced UI**: ToolGuardAudit "By Tool" tab, InferenceList filter bar, ObserveApp breadcrumb navigation
- [x] **API types**: TurnSummary, GuardByToolStat, AgentDetail, DimensionFilter

### Numbers (v0.2)
- **Source**: 9,094 lines (+1,384 from v0.1)
- **Tests**: 33 observe + 183 core/safe/mcp/tools = 216 total, all passing
- **Commits**: 68acb62 (observe v2), f07cd8a (observer fix), 595e398 (delegate/spawn fixes)

---

## v0.3 (planned) — Session Event Log + Agent Identity

> 详细设计见 PLAN-V0.3.md

### Phase 1: Session Event Log (core) ✅
- [x] SessionEvent 类型定义（Berry 格式，含 tool_use/tool_result 全文）
- [x] EventLogStore 接口 + FileEventLogStore（JSONL 实现）
- [x] Context Window Builder（从 Event Log 派生 messages[]）
- [x] Agent.query() 改造：每个 action → append event
- [x] Compaction 改造：只影响 context window，event log 不动
- [x] 向后兼容：无 eventLogStore 时行为完全不变
- [x] context builder tool_use 去重修复（1146d06）

### Phase 2: Agent Identity & Workspace (core) ✅
- [x] Agent Workspace 目录规范（agent.json + AGENT.md + MEMORY.md + .berry/）
- [x] AgentMemory 接口 + FileAgentMemory
- [x] ProjectContext 接口（可选绑定）
- [x] Agent 创建时自动初始化 workspace

### Phase 3: Observe 分层 (observe) ✅
- [x] collector/ 和 analyzer/ 目录分离
- [ ] metrics.ts — 派生指标（tool 成功率、重试率、cost efficiency）
- [ ] Dark mode 主题支持（CSS 变量）
- [ ] npm publish

### Future (v0.4+)
- [ ] Skill self-creation (L3+ on evolvability ladder)
- [ ] Credential Isolation middleware
- [ ] OpenTelemetry export
- [ ] Event Log → diary 自动摘要
- [ ] Event Log → memory search 集成
- [ ] Multi-agent orchestration protocol

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
