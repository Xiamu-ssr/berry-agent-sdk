# Compaction — Context Window Management

Berry Agent SDK uses a **two-tier, 7-layer compaction pipeline** to manage the context window. When the conversation grows too long, compaction automatically trims and summarizes older messages to stay within the model's context limit.

## How It Works

```
Agent Loop
  ↓
shouldCompact() — checks token usage against thresholds
  ↓
'soft' (≥60%) → cheap layers only (no LLM call)
'hard' (≥85%) → full 7-layer pipeline (includes LLM summarize)
'none'        → no compaction needed
```

**Key principle**: Compaction only affects the **Context Window** (what gets sent to the LLM). The **Event Log** (append-only JSONL) is never modified — you always have the full conversation history.

## Frontend Rendering: A + Marker

Recommended product pattern:

- **Render full history from the Event Log**
- **Insert `compaction_marker` as a system/timeline item**
- **Use `DefaultContextStrategy` only for provider reconstruction**

That gives you two separate views over the same session:

1. **UI Timeline** — full raw history + explicit compaction markers
2. **Context Window** — compacted provider-ready messages after the last marker

Berry exposes `toChatTimeline(events)` for the UI side:

```typescript
import { FileEventLogStore, toChatTimeline } from '@berry-agent/core';

const log = new FileEventLogStore('./workspace');
const events = await log.getEvents(sessionId);
const timeline = toChatTimeline(events);
```

Each compaction marker becomes a system item with structured metadata (`tokensFreed`, `contextBefore`, `contextAfter`, `layersApplied`, etc.), so the frontend does not need to guess from free-form text.

## Configuration

```typescript
const agent = Agent.create({
  // ...
  compaction: {
    contextWindow: 200_000,    // Model's context window (default: 200k)
    threshold: 170_000,        // Hard threshold: full compaction (default: 85%)
    softThreshold: 120_000,    // Soft threshold: cheap layers (default: 60%)
    enabledLayers: [           // Which layers to run at hard (default: all 7)
      'clear_thinking',
      'truncate_tool_results',
      'clear_tool_pairs',
      'merge_messages',
      'summarize',
      'trim_assistant',
      'truncate_oldest',
    ],
    softLayers: [              // Which layers to run at soft (default: first 3)
      'clear_thinking',
      'truncate_tool_results',
      'merge_messages',
    ],
  },
});
```

All fields are optional. Defaults work well for Claude (200k context) and GPT-4o (128k context).

### Threshold Behavior

| Condition | Trigger | What runs |
|-----------|---------|-----------|
| tokens < 60% of contextWindow | None | No compaction |
| tokens ≥ 60% (soft) | `softThreshold` | Only cheap layers: clear_thinking + truncate_tool_results + merge_messages |
| tokens ≥ 85% (hard) | `threshold` | Full 7-layer pipeline (includes LLM summarize call) |

Token count is determined by:
1. **Real `inputTokens`** from the last API response (preferred, accurate)
2. **Char-based estimate** (~4 chars/token) as fallback

## The 7 Layers

Layers run in order. Each layer is skipped if the token count is already below threshold after previous layers.

### Layer 1: `clear_thinking`
Removes thinking blocks from all messages except the most recent one. Thinking blocks are verbose and consume many tokens but have diminishing value in older turns.

### Layer 2: `truncate_tool_results`
Truncates oversized tool results to **50 lines** (head + tail), replacing the middle with `[...truncated N lines...]`. Preserves the first 25 and last 25 lines.

### Layer 3: `clear_tool_pairs`
Keeps only the **5 most recent** tool_use/tool_result pairs. Older pairs are replaced with `[called: tool_name — result compacted]`.

### Layer 4: `merge_messages`
Merges consecutive same-role text messages into one. This happens naturally after other layers remove content.

### Layer 5: `summarize` (LLM call)
The most powerful layer. Uses a **forked API call** to the same provider to generate a structured summary of older messages. The summary follows a 9-section format:

1. Primary Request and Intent
2. Key Technical Concepts
3. Files and Code Sections
4. Errors and Fixes
5. Problem Solving
6. All User Messages
7. Pending Tasks
8. Current Work
9. Optional Next Step

**Cache sharing**: The summarize call uses the same system prompt + tools as the main conversation, so Anthropic's prompt cache is reused (~96% cache hit). This is called "forked compact" — same technique as Claude Code.

Recent messages are preserved verbatim (default: 30% of messages or at least 10).

### Layer 6: `trim_assistant`
Trims long assistant messages (>3000 chars) to head (1500) + tail (1000) with `[...trimmed...]` in the middle.

### Layer 7: `truncate_oldest`
Last resort. Keeps 30% of messages (minimum 6), drops the rest. Inserts a placeholder: `[N older messages truncated]`.

## Pre-Compact Memory Flush

When `memory` is configured and a **hard** compaction is about to run, the agent first performs a **memory flush**:

1. Sends a silent LLM call asking: "Save important notes from this conversation"
2. The response is appended to the agent's `AgentMemory`
3. Then compaction runs

This prevents losing important context that compaction might summarize away.

```typescript
const agent = Agent.create({
  workspace: './my-agent',       // enables AgentMemory
  compaction: { ... },
  // memory flush happens automatically before hard compact
});
```

Events emitted: `memory_flush` (with `reason: 'pre_compact'` and `charsSaved`).

## Custom Compaction Strategy

You can replace the entire pipeline with your own strategy:

```typescript
import type { CompactionStrategy } from '@berry-agent/core';

class MyStrategy implements CompactionStrategy {
  async compact(messages, config, options) {
    // Your custom logic
    return {
      messages: compactedMessages,
      layersApplied: ['custom'],
      tokensFreed: originalTokens - newTokens,
    };
  }
}

const agent = Agent.create({
  compactionStrategy: new MyStrategy(),
  // ...
});
```

When `compactionStrategy` is provided, the default 7-layer pipeline is bypassed entirely.

## Events

Compaction emits two event types:

### `compaction` event
```typescript
{
  type: 'compaction',
  layersApplied: ['clear_thinking', 'truncate_tool_results', 'summarize'],
  tokensFreed: 45000,
  triggerReason: 'threshold',      // or 'soft_threshold'
  contextBefore: 175000,
  contextAfter: 130000,
  thresholdPct: 0.875,
  contextWindow: 200000,
  durationMs: 3200,
}
```

### `memory_flush` event
```typescript
{
  type: 'memory_flush',
  reason: 'pre_compact',
  charsSaved: 1250,
  durationMs: 2100,
}
```

### Event Log marker
A `compaction_marker` event is written to the JSONL event log:
```json
{
  "type": "compaction_marker",
  "strategy": "threshold",
  "triggerReason": "threshold",
  "tokensFreed": 45000,
  "contextBefore": 175000,
  "contextAfter": 130000,
  "thresholdPct": 0.875,
  "contextWindow": 200000,
  "layersApplied": ["clear_thinking", "truncate_tool_results", "summarize"],
  "durationMs": 3200
}
```

For backward compatibility, `strategy` is still present. Newer frontends should prefer the structured fields when available.

## Constants

| Constant | Default | Description |
|----------|---------|-------------|
| `DEFAULT_CONTEXT_WINDOW` | 200,000 | Model context window |
| `DEFAULT_COMPACTION_RATIO` | 0.85 | Hard threshold ratio |
| `DEFAULT_SOFT_COMPACTION_RATIO` | 0.60 | Soft threshold ratio |
| `TOOL_RESULT_MAX_LINES` | 50 | Max lines before truncation |
| `TOOL_PAIRS_KEEP_RECENT` | 5 | Recent tool pairs to keep |
| `TRIM_ASSISTANT_THRESHOLD` | 3,000 chars | Assistant message trim threshold |
| `TRIM_ASSISTANT_HEAD` | 1,500 chars | Chars to keep from start |
| `TRIM_ASSISTANT_TAIL` | 1,000 chars | Chars to keep from end |
| `TRUNCATE_OLDEST_MIN_KEEP` | 6 | Minimum messages to keep |
| `TRUNCATE_OLDEST_KEEP_RATIO` | 0.30 | Ratio of messages to keep |
| `SUMMARIZE_MIN_MESSAGES` | 10 | Don't summarize if fewer |
| `SUMMARIZE_RECENT_RATIO` | 0.30 | Ratio of messages preserved verbatim |

## Comparison with Claude Code

Berry SDK's compaction is directly inspired by CC's pipeline:

| Feature | CC | Berry SDK |
|---------|----|----|
| Layers | 7 (same order) | 7 (same order) |
| Trigger | Single threshold (85%) | Two-tier: soft (60%) + hard (85%) |
| Summarize prompt | 9-section structured | Same 9-section structured |
| Cache sharing | Forked compact | Same forked compact |
| Memory flush | No (pre-compact flush is Berry extension) | Yes |
| Custom strategy | No | Yes (CompactionStrategy interface) |
| Event Log preservation | No (compact is destructive) | Yes (Event Log never modified) |
