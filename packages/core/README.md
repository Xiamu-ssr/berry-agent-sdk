# @berry-agent/core

Pure-library Agent SDK for building AI agents with TypeScript. No CLI dependency, no framework lock-in.

## Features

- **Agent loop** — tool-calling loop with automatic iteration + parallel execution
- **Providers** — Anthropic (with prompt cache) + OpenAI-compatible
- **Session Event Log** — append-only JSONL recording (crash-safe, never modified by compaction)
- **Compaction** — two-tier (soft 60% + hard 85%), 7-layer pipeline with forked cache sharing. See [docs/compaction.md](../../docs/compaction.md)
- **Pre-compact memory flush** — saves important context to AgentMemory before hard compaction
- **CompactionStrategy** — pluggable interface to replace the default pipeline
- **Delegate** — one-shot fork execution with cache sharing (like CC's `runForkedAgent`)
- **Spawn** — persistent sub-agents with lifecycle management
- **Skills** — SKILL.md loader compatible with CC, ClawHub, and SkillsDirectory
- **Tool Guard** — pluggable permission hook (deny/allow/modify)
- **Middleware** — `onBeforeApiCall` / `onAfterApiCall` / `onBeforeToolExec` / `onAfterToolExec`
- **Lifecycle hooks** — `onQueryStart` / `onQueryEnd`
- **Agent status** — fine-grained runtime phases (`thinking` / `tool_executing` / `compacting` / `memory_flushing` / `delegating`)
- **Chat UI helpers** — `toChatMessages()` for Message[] + `toChatTimeline()` for full Event Log timelines with compaction markers
- **Structured Output** — JSON schema responses (Anthropic tool-based + OpenAI `response_format`)
- **Multi-modal** — image input support (base64)
- **Streaming** — text + thinking deltas + 16 event types
- **Stream idle timeout** — auto-abort stalled provider streams
- **Agent Workspace** — independent directory per agent (agent.json + AGENT.md + MEMORY.md)
- **Agent Memory** — persistent memory via AgentMemory interface (file/mem0/zep backends in `@berry-agent/memory`)
- **MCP** — via `@berry-agent/mcp` adapter package

## Install

```bash
npm install @berry-agent/core
```

## Quick Start

```typescript
import { Agent } from '@berry-agent/core';

const agent = new Agent({
  provider: {
    type: 'anthropic',
    apiKey: process.env.ANTHROPIC_API_KEY!,
    model: 'claude-sonnet-4-20250514',
  },
  systemPrompt: 'You are a helpful assistant.',
});

const result = await agent.query('Hello!');
console.log(result.text);
```

## Tools

```typescript
const agent = new Agent({
  // ...provider config
  systemPrompt: 'You are a coding assistant.',
  tools: [{
    definition: {
      name: 'read_file',
      description: 'Read a file from disk',
      inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    },
    execute: async (input) => {
      const content = await readFile(input.path as string, 'utf-8');
      return { content };
    },
  }],
});
```

## UI Timeline from Event Log

Use the append-only Event Log as the frontend source of truth, then convert it into timeline items for rendering:

```typescript
import { FileEventLogStore, toChatTimeline } from '@berry-agent/core';

const log = new FileEventLogStore('./my-agent-workspace');
const events = await log.getEvents(sessionId);
const timeline = toChatTimeline(events);

for (const item of timeline) {
  if (item.kind === 'compaction_marker') {
    console.log(item.content);           // e.g. "Context compaction — freed ~45,000 tokens"
    console.log(item.compaction);        // structured metadata for badges / details drawers
  } else {
    console.log(item.role, item.content);
  }
}
```

`DefaultContextStrategy` still builds provider messages from **after the last `compaction_marker`** only. `toChatTimeline()` is for UI rendering, not for model context reconstruction.

## Delegate (One-Shot Fork)

Cache-sharing delegation — the delegate sees your main conversation as context prefix:

```typescript
// First, have a main conversation
await agent.query('I am building a TypeScript SDK...');

// Delegate a focused task (shares prompt cache with main conversation)
const review = await agent.delegate('Review package.json for issues', {
  appendSystemPrompt: 'You are a code reviewer. Focus on dependency hygiene.',
  maxTurns: 5,
});
console.log(review.text);    // Final result
console.log(review.usage);   // Token usage
```

## Spawn (Persistent Sub-Agent)

```typescript
const researcher = agent.spawn({
  systemPrompt: 'You are a research assistant.',
  model: 'claude-sonnet-4-20250514',  // cheaper model
});

const r1 = await researcher.query('What is prompt caching?');
const r2 = await researcher.query('How does it compare to OpenAI?', { resume: r1.sessionId });

agent.destroyChild('researcher');
```

## Tool Guard

```typescript
const agent = new Agent({
  // ...config
  toolGuard: async ({ toolName, input }) => {
    if (toolName === 'exec') return { action: 'deny', reason: 'No shell access' };
    return { action: 'allow' };
  },
});
```

## Middleware

```typescript
const agent = new Agent({
  // ...config
  middleware: [{
    onBeforeApiCall: (request, ctx) => {
      console.log(`API call: ${ctx.model}, ${request.messages.length} messages`);
      return request;
    },
    onAfterToolExec: (name, input, result, ctx) => {
      console.log(`Tool ${name}: ${result.isError ? 'ERROR' : 'OK'}`);
    },
  }],
});
```

## Structured Output

```typescript
const result = await agent.query('Extract the key info from this text', {
  responseFormat: {
    name: 'extracted_info',
    schema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        summary: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
      },
      required: ['title', 'summary', 'tags'],
    },
  },
});
const data = JSON.parse(result.text);
```

## Skills (SKILL.md)

Compatible with Claude Code, ClawHub, and SkillsDirectory formats:

```typescript
const agent = new Agent({
  // ...config
  skillDirs: ['./skills', '~/.config/skills'],
});

// Skills are indexed in the system prompt (name + description only).
// Full content loaded lazily via agent.getSkill(name).
```

## Architecture

```
@berry-agent/core          — Agent, providers, compaction, event log, workspace, skills
@berry-agent/tools-common  — 10 pre-built tools (file, shell, search, web, browser)
@berry-agent/observe       — SQLite observability (collector + analyzer + REST + dashboard)
@berry-agent/safe          — Guards, LLM classifier, PI probe, audit
@berry-agent/mcp           — MCP client → Berry tool adapter
@berry-agent/memory        — Memory backends (file, mem0, zep)
```

## License

MIT
