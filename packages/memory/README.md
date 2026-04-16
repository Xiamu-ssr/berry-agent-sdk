# @berry-agent/memory

Memory backend adapters for [Berry Agent SDK](https://github.com/Xiamu-ssr/berry-agent-sdk).

## Backends

| Backend | Search | Storage | Use case |
|---------|--------|---------|----------|
| `FileMemoryBackend` | Substring | Local JSON files | Dev, single-agent |
| `Mem0MemoryBackend` | Semantic (vector) | mem0 API | Production, multi-agent |
| `ZepMemoryBackend` | Semantic (graph) | Zep API | Production, conversation memory |

## Quick Start

```typescript
import { Agent } from '@berry-agent/core';
import { FileMemoryBackend } from '@berry-agent/memory';

// 1. Create backend
const memory = new FileMemoryBackend({ dir: './agent-memory' });

// 2. Pass to Agent as AgentMemory
const agent = Agent.create({
  model: 'claude-haiku-4.5',
  apiKey: process.env.ANTHROPIC_API_KEY!,
  workspace: './workspace',
  // Override default file memory with our backend
});

// 3. Use search directly (for memory_search tool, RAG, etc.)
const results = await memory.search('architecture decisions', { limit: 5 });
```

## Active vs Passive Retrieval

The memory backend supports both patterns:

- **Active (tool-based):** Register a `memory_search` tool that calls `backend.search()`. The LLM decides when to search.
- **Passive (auto-inject):** In middleware `onBeforeApiCall`, call `backend.search(userMessage)` and prepend results to system prompt.

Both patterns work with any backend. The choice is a product decision, not an SDK constraint.

## License

MIT
