# Berry Agent SDK 🍓

A standalone, pure-library Agent SDK with built-in compaction, cache optimization, and multi-provider support.

**The missing middle ground** — no CLI dependency, no black box. Just a clean library that manages your agent's context intelligently.

## Why?

| Existing SDK | Problem |
|---|---|
| Claude Agent SDK | Wraps Claude Code CLI — not a real library |
| OpenAI Agents SDK | No compaction, no cache optimization |
| LangChain/CrewAI | No compaction, no cache optimization |
| OpenClaw | Incremental compression destroys cache |

Berry Agent SDK fills the gap: **a pure library with compaction + cache + multi-model support**.

## Features

- 🧠 **7-layer compaction pipeline** — Inspired by Claude Code's proven approach
- ⚡ **Cache-aware context management** — Stable prefix strategy for maximum cache hit rate
- 🔌 **Multi-provider** — Anthropic (explicit cache_control) + OpenAI (automatic caching)
- 🛠️ **Tool registration** — Define, register, and permission-scope custom tools
- 📋 **Skill injection** — Markdown-based skill definitions injected into system prompt
- 💾 **Session management** — messages[] + persistence + resume/fork
- 🏗️ **Pure library** — No CLI dependency, no subprocess spawning, zero startup overhead

## Quick Start

```typescript
import { Agent, AnthropicProvider } from '@berry-agent/core';

const agent = new Agent({
  provider: new AnthropicProvider({
    baseUrl: process.env.ANTHROPIC_BASE_URL,  // zenmux, etc.
    apiKey: process.env.ANTHROPIC_API_KEY,
    model: 'claude-sonnet-4',
  }),
  systemPrompt: 'You are a helpful assistant.',
  tools: [myCustomTool],
  cwd: './my-workspace',
});

// Simple query
const result = await agent.query('Hello!');

// With tool restrictions
const result2 = await agent.query('Analyze this code', {
  allowedTools: ['read_file', 'grep'],
});

// Resume previous session
const result3 = await agent.query('Continue where we left off', {
  resume: 'session-id',
});
```

## Architecture

```
packages/
  ├── core/           # TypeScript core (agent loop, compaction, cache, session)
  ├── python/         # Python binding (Phase 2)
  └── rust/           # Rust binding (Phase 2)
```

## Compaction Pipeline (7 layers)

1. Clear old thinking blocks
2. Truncate oversized tool results (head + tail)
3. Clear completed tool_use/tool_result pairs (keep summary)
4. Merge consecutive same-type messages
5. Summarize old conversation (LLM-generated)
6. Remove redundant assistant message parts
7. Last resort — truncate oldest messages

## Cache Strategy

### Anthropic (explicit breakpoints)
```
[system_static]     ← cache breakpoint 1 (never changes)
[system_dynamic]    ← cache breakpoint 2 (skills/CLAUDE.md, rarely changes)
[conversation]      ← cache breakpoint 3 (grows, compaction resets)
[latest_message]    ← cache breakpoint 4 (auto-moves)
```

### OpenAI (automatic prefix caching)
- Keep request prefix stable → automatic cache hit
- No explicit markers needed

## Roadmap

- [ ] Phase 1: TypeScript core MVP (compaction + cache + session + multi-provider)
- [ ] Phase 2: Python binding
- [ ] Phase 3: Rust binding
- [ ] Phase 4: Memory tools (memory_get / memory_search / memory_store)
- [ ] Phase 5: Skill system

## License

MIT
