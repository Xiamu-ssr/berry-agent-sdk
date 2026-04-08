# @berry-agent/core

Berry Agent SDK core package.

A pure-library agent runtime for TypeScript with:

- agent loop
- tool calling
- session resume / fork
- file-backed session persistence
- batch compaction
- cache-aware Anthropic adapter
- OpenAI-compatible adapter
- streaming + events

## Install

```bash
npm install @berry-agent/core
```

## Quick start

```ts
import { Agent } from '@berry-agent/core'

const agent = new Agent({
  provider: {
    type: 'anthropic',
    apiKey: process.env.ANTHROPIC_API_KEY!,
    model: 'claude-sonnet-4-20250514',
  },
  systemPrompt: 'You are a concise assistant.',
})

const result = await agent.query('Say hello')
console.log(result.text)
```

## File session store

```ts
import { Agent, FileSessionStore } from '@berry-agent/core'

const agent = new Agent({
  provider: {
    type: 'openai',
    apiKey: process.env.OPENAI_API_KEY!,
    model: 'gpt-5.4',
  },
  systemPrompt: 'You are helpful.',
  sessionStore: new FileSessionStore('.berry/sessions'),
})
```

## Streaming

```ts
await agent.query('Explain cache optimization', {
  stream: true,
  onEvent(event) {
    if (event.type === 'text_delta') process.stdout.write(event.text)
  },
})
```

## Status

Alpha. Current scope is the core runtime, not channels / memory / sandbox / MCP.
