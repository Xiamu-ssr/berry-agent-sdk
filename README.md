# Berry Agent SDK 🍓

A pure-library Agent SDK for TypeScript with:

- **agent loop**
- **session resume / fork**
- **batch compaction**
- **cache-aware provider adapters**
- **tool calling**
- **streaming + events**
- **Anthropic + OpenAI-compatible providers**

Berry is aimed at the gap between thin model SDKs and black-box agent CLIs.

## Why

Most agent SDKs give you one or two of these:

- tool calling
- session state
- multi-model support
- compaction
- cache optimization

Berry tries to make those core pieces work **together** in one small library.

## Current status

This repo is currently **alpha**.

What exists today:

- Anthropic provider
  - system prompt block splitting
  - `cache_control` breakpoints
  - extended thinking support
  - streaming
- OpenAI-compatible provider
  - OpenAI / DeepSeek / Qwen / Groq / Together / Ollama style endpoints
  - automatic cache-friendly prefix handling
  - streaming
- Agent loop
  - tool execution loop
  - `resume` / `fork`
  - per-query tool restriction
- Compaction
  - 7-layer batch compaction pipeline
- Session store
  - in-memory store
  - file-backed JSON store
- Events
  - query lifecycle
  - streaming deltas
  - tool execution events
- Tests
  - agent loop
  - compaction
  - session store
  - provider adapters

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
  systemPrompt: [
    'You are a helpful assistant.',
    'Prefer concise answers.',
  ],
})

const result = await agent.query('Say hello')
console.log(result.text)
```

## Tool loop

```ts
import { Agent, type ToolRegistration } from '@berry-agent/core'

const readFileTool: ToolRegistration = {
  definition: {
    name: 'read_file',
    description: 'Read a file',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
      },
      required: ['path'],
    },
  },
  execute: async (input) => {
    return {
      content: `fake contents of ${String(input.path)}`,
    }
  },
}

const agent = new Agent({
  provider: {
    type: 'openai',
    apiKey: process.env.OPENAI_API_KEY!,
    model: 'gpt-5.4',
  },
  systemPrompt: 'Use tools when needed.',
  tools: [readFileTool],
})

const result = await agent.query('Read src/index.ts')
console.log(result.text)
```

## Sessions

Berry keeps canonical conversation state as:

- `systemPrompt: string[]`
- `messages: Message[]`
- `metadata`

Resume an existing session:

```ts
const first = await agent.query('Plan the work')
const second = await agent.query('Continue', {
  resume: first.sessionId,
})
```

Fork a session:

```ts
const forked = await agent.query('Take another approach', {
  fork: first.sessionId,
})
```

## File session store

```ts
import { Agent, FileSessionStore } from '@berry-agent/core'

const agent = new Agent({
  provider: {
    type: 'anthropic',
    apiKey: process.env.ANTHROPIC_API_KEY!,
    model: 'claude-sonnet-4-20250514',
  },
  systemPrompt: 'You are helpful.',
  sessionStore: new FileSessionStore('.berry/sessions'),
})
```

This stores one session per JSON file.

## Streaming + events

```ts
const result = await agent.query('Explain compaction briefly', {
  stream: true,
  onEvent(event) {
    if (event.type === 'text_delta') {
      process.stdout.write(event.text)
    }

    if (event.type === 'tool_call') {
      console.log(`\n[tool] ${event.name}`)
    }

    if (event.type === 'api_response') {
      console.log('\nusage:', event.usage)
    }
  },
})

console.log('\nfinal:', result.text)
```

Supported event kinds:

- `query_start`
- `api_call`
- `text_delta`
- `thinking_delta`
- `api_response`
- `tool_call`
- `tool_result`
- `compaction`
- `query_end`

## Provider notes

### Anthropic

Berry uses explicit cache breakpoints for stable prefixes:

- system prompt blocks
- recent turn boundaries

### OpenAI-compatible

Berry relies on provider-side automatic prefix caching when available.
No explicit cache breakpoint API is required.

## Compaction

Berry currently uses a **batch compaction** strategy rather than progressive per-request mutation.

Current layers:

1. clear thinking
2. truncate oversized tool results
3. clear old tool pairs
4. merge consecutive messages
5. summarize old messages
6. trim long assistant messages
7. truncate oldest messages

## Examples

See:

- `examples/basic.ts`
- `examples/smoke-anthropic.ts`
- `examples/smoke-openai.ts`

## Development

```bash
npm install
npm run build
npm test
```

Package-only test run:

```bash
npm test --workspace=packages/core -- --run
```

## Not in scope yet

Not implemented yet:

- MCP
- sandbox / permissions
- memory system
- multi-language bindings
- benchmark harness
- npm-stable release hardening

## License

MIT
