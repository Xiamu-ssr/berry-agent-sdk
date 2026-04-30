# Berry Agent SDK 🍓

TypeScript Agent Harness SDK — the infrastructure layer for building autonomous AI agents.

```
@berry-agent/core          Agent loop, providers, compaction, skills, delegate/spawn
@berry-agent/tools-common  Pre-built tools (file, shell, search, web, browser)
@berry-agent/observe       Full-stack observability (SQLite + analyzers + REST + dashboard UI)
@berry-agent/safe          Guards, LLM classifier, PI probe, audit
@berry-agent/mcp           MCP client → Berry tool adapter
@berry-agent/memory-file   File-system memory provider (chunked markdown + retrieval)
@berry-agent/models        Unified model registry & provider tier resolution
@berry-agent/team          Multi-agent team orchestration (worklist, roles, leader)
```

## Install

```bash
npm install @berry-agent/core @berry-agent/tools-common
# Optional:
npm install @berry-agent/observe @berry-agent/safe @berry-agent/mcp
npm install @berry-agent/memory-file @berry-agent/models @berry-agent/team
```

## Quick Start

```ts
import { Agent } from '@berry-agent/core';
import { createAllTools } from '@berry-agent/tools-common';

const agent = Agent.create({
  providerType: 'anthropic',
  apiKey: process.env.ANTHROPIC_API_KEY!,
  model: 'claude-sonnet-4-20250514',
  systemPrompt: 'You are a helpful coding assistant.',
  tools: createAllTools('./workspace'),
});

const result = await agent.query('Read src/index.ts and explain it');
console.log(result.text);
```

## Core Features

### Agent Loop
- Tool calling with **parallel execution** (Promise.all)
- Session resume / fork with FileSessionStore
- **Session Event Log** (append-only JSONL, crash-safe)
- **7-layer batch compaction** with pluggable `CompactionStrategy`
- **Pre-compact memory flush** (save important context before compaction)
- **Stream idle timeout** (auto-abort stalled provider streams)
- Streaming + 16 event types
- Structured output (JSON schema)
- Lifecycle hooks: `onQueryStart` / `onQueryEnd`
- `ChatMessage` type + `toChatMessages()` converter

### Built-in Agent Tools
- **delegate** — LLM self-decides to fork a one-shot sub-agent for complex sub-tasks
- **spawn_agent** — LLM creates persistent sub-agents (e.g., a dedicated reviewer)
- **load_skill** — On-demand skill loading from SKILL.md directories

### Multi-Provider
```ts
import { ProviderRegistry, Agent } from '@berry-agent/core';

const registry = new ProviderRegistry();
registry.register('anthropic', {
  type: 'anthropic', apiKey: '...', models: ['claude-sonnet-4-20250514', 'claude-haiku-4-20250414'],
});
registry.register('openai', {
  type: 'openai', apiKey: '...', models: ['gpt-4o', 'gpt-4o-mini'],
});
registry.setDefault('claude-sonnet-4-20250514');

const agent = Agent.create({ registry, systemPrompt: '...' });
agent.switchProvider(registry.toProviderConfig('gpt-4o')); // runtime switch
```

### 10 Pre-built Tools (@berry-agent/tools-common)
| Tool | Description |
|------|-------------|
| read_file / write_file / list_files | File ops scoped to base dir |
| edit_file | Exact text replacement |
| shell | Command execution with blocked commands |
| grep / find_files | Code search |
| web_fetch | HTTP → markdown (free, no API key) |
| web_search | Tavily / Brave / SerpAPI (adapter pattern) |
| browser | Playwright: navigate, snapshot, screenshot, click, type, evaluate |

### Observability (@berry-agent/observe)
```ts
import { createObserver, startObserveServer } from '@berry-agent/observe';

const observer = createObserver({ dbPath: './observe.db' });

// Use as middleware in your agent:
const agent = new Agent({
  // ...
  middleware: [observer.middleware],
  onEvent: observer.onEvent,
});

// Option A: Embed in your Express app
app.use('/api/observe', createObserveRouter(observer));

// Option B: Standalone server with built-in dashboard
startObserveServer(observer, { port: 4200 });
```

9 analyzers: cost breakdown, cost by model, cost trend, cache efficiency, tool stats, guard stats, inference detail, session summary, agent stats.

### Safety (@berry-agent/safe)
```ts
import { compositeGuard, directoryScope, denyList } from '@berry-agent/safe';

const agent = new Agent({
  // ...
  toolGuard: compositeGuard(
    directoryScope('./workspace'),
    denyList(['rm -rf /', 'DROP TABLE']),
  ),
});
```

## Architecture

```
Your App (e.g., berry-claw)
    ↓
@berry-agent/core          ← Agent loop, providers, session, compaction
    ↓
@berry-agent/tools-common  ← Pre-built tools (peer dep on core)
@berry-agent/observe       ← Observability (peer dep on core + express)
@berry-agent/safe          ← Security guards (peer dep on core)
@berry-agent/mcp           ← MCP integration (peer dep on core)
```

## Status

Alpha. Packages ship on the `alpha` dist-tag and share no single version —
each package (`@berry-agent/core`, `mcp`, `memory-file`, `observe`, `safe`,
`tools-common`, `models`, `team`) is versioned independently.

## Development

```bash
npm install
npm run build          # Build all packages
npm test               # Run unit tests
npm run test:integration  # Integration tests (requires API keys)
```

## Roadmap

See [ROADMAP.md](./ROADMAP.md)

## License

MIT
