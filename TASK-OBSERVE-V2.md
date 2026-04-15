# TASK: Observe V2 — Turn Dimension + Wire Format + Multi-Dimension Analytics

## Context
- Berry Agent SDK monorepo: `packages/core`, `packages/observe`, `packages/observe/ui`
- SQLite via Drizzle ORM (`packages/observe/src/schema.ts`)
- React UI components in `packages/observe/ui/src/components/`
- Express API in `packages/observe/src/server.ts`
- Analyzer in `packages/observe/src/analyzer.ts`
- Collector (middleware + event listener) in `packages/observe/src/collector.ts`

## P0: Critical Fixes

### 1. Fix Stream Wire Format (SDK Core Bug)

**Problem**: `stream()` in providers doesn't include `rawRequest`/`rawResponse` in the final response event, so observe DB stores null for these fields → UI shows "Wire format request/response not available".

**Files**: 
- `packages/core/src/providers/anthropic.ts` — `stream()` method
- `packages/core/src/providers/openai.ts` — `stream()` method

**Fix**: In both providers' `stream()` method, the final `yield { type: 'response', response: { ... } }` must include:
- `rawRequest`: The params object built for the API call (same as `chat()` does)
- `rawResponse`: Accumulated stream data (at minimum: usage, stop_reason, content blocks). For Anthropic, collect the `message` object from `message_start`/`message_delta` events. For OpenAI, accumulate from stream chunks.

**Check**: `chat()` method already does this correctly in both providers — mirror the pattern.

### 2. Add Turn (Query) Dimension to Schema

**Concept**: A "Turn" = one user message → full agent loop (multiple LLM calls + tool executions) → final response. Maps to `query_start` → `query_end` in agentEvents.

**Schema change** (`packages/observe/src/schema.ts`):

Add `turnId` column to `llm_calls`:
```typescript
turnId: text('turn_id'),  // links to agentEvents query_start
```

Add new `turns` table:
```typescript
export const turns = sqliteTable('turns', {
  id: text('id').primaryKey(),
  sessionId: text('session_id').notNull().references(() => sessions.id),
  agentId: text('agent_id'),
  prompt: text('prompt'),          // user message (truncated)
  startTime: integer('start_time').notNull(),
  endTime: integer('end_time'),
  llmCallCount: integer('llm_call_count').notNull().default(0),
  toolCallCount: integer('tool_call_count').notNull().default(0),
  totalCost: real('total_cost').notNull().default(0),
  status: text('status', { enum: ['active', 'completed', 'error'] }).notNull(),
});
```

Also add `turnId` to `toolCalls` and `guardDecisions` tables.

**DB Migration**: Since we use `drizzle-kit push` (not formal migrations), just update schema. Add a comment about the new columns.

### 3. Wire Turn into Collector

**File**: `packages/observe/src/collector.ts`

In `createEventListener`:
- On `query_start`: generate `turnId = nanoid()`, insert into `turns` table, store `currentTurnId`
- On `query_end`: update `turns` row with endTime, final counts, status

In `createMiddleware`:
- Need access to `currentTurnId` — the middleware and event listener must share state
- **Solution**: Add a `getCurrentTurnId()` callback to `CollectorConfig`, or better: make `createCollector()` that returns both middleware + event listener sharing internal state

Refactor:
```typescript
export function createCollector(config: CollectorConfig): {
  middleware: Middleware;
  eventListener: (event: AgentEvent) => void;
} {
  // shared state
  let currentTurnId: string | undefined;
  let currentSessionId: string | undefined;
  
  // ... middleware uses currentTurnId when inserting llm_calls, tool_calls, guard_decisions
  // ... event listener sets currentTurnId on query_start, clears on query_end
}
```

Keep `createMiddleware` and `createEventListener` as convenience wrappers but deprecate in favor of `createCollector`.

### 4. Multi-Dimension Analyzer

**File**: `packages/observe/src/analyzer.ts`

All existing analysis methods need to support filtering by multiple dimensions:

```typescript
interface DimensionFilter {
  sessionId?: string;
  agentId?: string;
  turnId?: string;
}
```

Update these methods to accept `DimensionFilter`:
- `costBreakdown(filter?)` — already has sessionId, add agentId + turnId
- `cacheEfficiency(filter?)` — same
- `guardStats(filter?)` — same
- `compactionStats(filter?)` — same (compaction only has sessionId, but can filter)
- `toolStats(filter?)` — same

New methods:
- `turnList(filter?: { sessionId?: string; agentId?: string; limit?: number })` → list turns
- `turnSummary(turnId: string)` → turn detail with aggregated cost/cache/guard/compaction
- `guardStatsByTool(filter?)` → GROUP BY toolName, return per-tool allow/deny/modify counts + deny rate
- `agentDetail(agentId: string)` → agent info + aggregated stats + session list

## P1: API + UI

### 5. New API Endpoints

**File**: `packages/observe/src/server.ts`

Add:
```
GET /turns?sessionId=&agentId=&limit=     → analyzer.turnList(...)
GET /turns/:id                            → analyzer.turnSummary(...)
GET /turns/:id/inferences                 → analyzer.inferenceList({ turnId })
GET /guard/by-tool?sessionId=&agentId=    → analyzer.guardStatsByTool(...)
GET /agents/:id                           → analyzer.agentDetail(...)
GET /agents/:id/sessions                  → analyzer.recentSessions() filtered by agentId
```

Update existing endpoints to accept additional query params:
- `GET /inferences` — add `turnId`, `model`, `since`, `until` query params
- `GET /cost` — add `agentId`, `turnId` 
- `GET /cache` — add `agentId`, `turnId`
- `GET /guard` — add `agentId`, `turnId`
- `GET /compaction` — add `agentId`

Update `api-types.ts` with new types:
```typescript
export interface TurnSummary {
  id: string;
  sessionId: string;
  agentId: string | null;
  prompt: string | null;
  startTime: number;
  endTime: number | null;
  llmCallCount: number;
  toolCallCount: number;
  totalCost: number;
  status: string;
  // aggregated
  cost: CostBreakdown;
  cache: CacheEfficiency;
  guard: GuardStat;
}

export interface GuardByToolStat {
  toolName: string;
  allowCount: number;
  denyCount: number;
  modifyCount: number;
  totalCount: number;
  denyRate: number;
}

export interface AgentDetail {
  agentId: string;
  sessionCount: number;
  totalCost: number;
  llmCallCount: number;
  toolCallCount: number;
  avgCostPerSession: number;
  cost: CostBreakdown;
  cache: CacheEfficiency;
  guard: GuardStat;
  recentSessions: SessionSummary[];
}
```

### 6. UI Components

**Directory**: `packages/observe/ui/src/components/`

#### 6a. Agent Detail Page (NEW)
File: `AgentDetail.tsx`
- Click agent card in AgentDashboard → navigate to agent detail
- Show: agent stats banner (cost, cache, guard, compaction mini cards)
- Session list for this agent
- Click session → go to session detail (new)

#### 6b. Session Detail Page (NEW)
File: `SessionDetail.tsx`
- Show: session stats banner (cost, cache, guard, compaction)
- Turns list for this session
- Click turn → expand or navigate to turn detail

#### 6c. Turn List + Turn Detail (NEW)
File: `TurnList.tsx`, `TurnDetail.tsx`
- TurnList: shows turns with prompt preview, LLM call count, cost
- TurnDetail: shows turn stats (cost/cache/guard/compaction) + inference list for this turn

#### 6d. Guard Per-Tool View (ENHANCE)
File: Update `ToolGuardAudit.tsx`
- Add a "By Tool" tab/section showing table: tool name | allow | deny | modify | deny rate
- Click tool name → filter decision list to that tool
- Support dimension filter (sessionId, agentId, turnId)

#### 6e. Mini Stats Bar Component (NEW)
File: `MiniStats.tsx`
- Reusable component: horizontal bar showing Cost | Cache Hit Rate | Guard (deny count) | Compactions
- Used in: AgentDetail, SessionDetail, TurnDetail, InferenceDetail

#### 6f. Inference List Filters (ENHANCE)
File: Update `InferenceList.tsx`
- Add filter bar: model dropdown, time range, cost range
- Support turnId filter (when navigating from turn detail)
- Search/filter by stop reason

#### 6g. Navigation Enhancement
File: Update `ObserveApp.tsx`
- Add new views: `agent-detail`, `session-detail`, `turn-list`, `turn-detail`
- Wire up drill-down navigation: agents → agent detail → sessions → session detail → turns → turn detail → inferences → inference detail
- Add breadcrumb navigation

### 7. Update Exports

**File**: `packages/observe/src/index.ts`
- Export `createCollector` (new unified factory)
- Export new types from api-types.ts
- Keep backward compat: still export `createMiddleware`, `createEventListener`

## Constraints

- TypeScript strict mode, no `any` in new code (existing `any` in UI is OK for now)
- All existing tests must pass: `cd packages/observe && npx vitest run`
- New tests for: turnId collection, multi-dimension analyzer queries, guardStatsByTool
- UI: Tailwind-free (current UI uses inline/className strings, keep consistent)
- React 19 compatible
- Do NOT modify `packages/safe` or `packages/mcp`

## When Done

1. Run `npx tsc --noEmit -p packages/core/tsconfig.json` — must pass
2. Run `npx tsc --noEmit -p packages/observe/tsconfig.json` — must pass
3. Run `cd packages/observe && npx vitest run` — all tests pass
4. Run `cd packages/core && npx vitest run` — all tests pass
5. Commit all changes with descriptive message

When completely finished, run this command to notify me:
openclaw system event --text "Done: Berry Agent SDK observe v2 — turn dimension, wire format fix, multi-dimension analytics, enhanced UI with drill-down" --mode now
