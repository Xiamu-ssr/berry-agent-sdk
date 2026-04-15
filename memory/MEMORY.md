# Berry Agent SDK — Working Memory

## Project Overview
Monorepo: `packages/core`, `packages/observe`, `packages/tools-common`, `packages/safe`, `packages/mcp`.
- Core: agent runtime, provider adapters (Anthropic + OpenAI-compat), types
- Observe: SQLite/Drizzle ORM telemetry, Express REST API, React UI
- Do NOT modify `packages/safe` or `packages/mcp` unless explicitly asked

## Key Architecture
- **Provider abstraction**: `AnthropicProvider` (cache_control breakpoints) + `OpenAIProvider` (compatible endpoints)
- **Middleware pattern**: `createCollector()` returns `{ middleware, eventListener }` sharing state
- **Schema-first**: Drizzle ORM, migrations in `db.ts` via `ALTER TABLE` catch-block pattern
- **API-UI sync**: `packages/observe/src/api-types.ts` is single source of truth

## Observe V2 (completed)
- `turns` table: query_start → query_end = one turn; `turn_id` FK on llm_calls/tool_calls/guard_decisions
- `createCollector()`: preferred over separate `createMiddleware()`/`createEventListener()`
- `DimensionFilter { sessionId?, agentId?, turnId? }`: all analyzer methods accept it
- New analyzer methods: `turnList()`, `turnSummary()`, `guardStatsByTool()`, `agentDetail()`
- New API endpoints: `/turns`, `/turns/:id`, `/turns/:id/inferences`, `/guard/by-tool`, `/agents/:id`, `/agents/:id/sessions`
- New UI components: `MiniStats`, `TurnList`, `TurnDetail`, `SessionDetail`, `AgentDetail`
- stream() providers now populate `rawRequest`/`rawResponse` (was null before)

## UI Conventions
- No Tailwind JIT — use className strings only (Tailwind utility classes are OK as static strings)
- React 19 compatible
- Hooks: `useObserveApi<T>(baseUrl, path)` returns `{ data, loading }`
- Style: white cards with `border border-gray-200 rounded-xl`, indigo for active states

## Test Files
- `packages/observe/src/__tests__/observe.test.ts` — 33 tests
- `packages/core/src/__tests__/provider-streaming.test.ts` — uses `expect.objectContaining` for response event (rawRequest/rawResponse now populated)

## Commands
- TypeScript: `npx tsc --noEmit -p packages/core/tsconfig.json` and `packages/observe/tsconfig.json`
- Tests: `cd packages/observe && npx vitest run`, `cd packages/core && npx vitest run`
- Notification: `openclaw system event --text "..." --mode now`
