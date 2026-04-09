# @berry-agent/core

Pure-library Agent SDK for building AI agents with TypeScript. No CLI dependency, no framework lock-in.

## Features

- **Agent loop** — tool-calling loop with automatic iteration
- **Providers** — Anthropic (with prompt cache) + OpenAI-compatible
- **Compaction** — 7-layer context compaction pipeline (forked compact for cache sharing)
- **Delegate** — one-shot fork execution with cache sharing (like CC's `runForkedAgent`)
- **Spawn** — persistent sub-agents with lifecycle management
- **Skills** — SKILL.md loader compatible with CC, ClawHub, and SkillsDirectory
- **Tool Guard** — pluggable permission hook (deny/allow/modify)
- **Middleware** — `onBeforeApiCall` / `onAfterApiCall` / `onBeforeToolExec` / `onAfterToolExec`
- **Structured Output** — JSON schema responses (Anthropic tool-based + OpenAI `response_format`)
- **Multi-modal** — image input support (base64)
- **Streaming** — text + thinking deltas
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
@berry-agent/core          — Agent, providers, compaction, tools, skills
@berry-agent/mcp           — MCP client → Berry tool adapter
@berry-agent/safe (future) — Pre-built guards, sandbox policies
@berry-agent/team (future) — Multi-agent team orchestration
```

## License

MIT
