# Berry Agent SDK

TypeScript packages for building long-running, tool-using AI agents.

Berry Agent keeps the runtime split deliberately small:

- `messages.json` is the provider context source for LLM inference.
- `events.jsonl` is the append-only UI and audit source.
- `AGENTS.md`, `MEMORY.md`, skills, MCP config, and project context live in an `AgentHome`.
- Prompt behavior is selected through SDK-level PromptPacks instead of one-off hardcoded prompts.

See [AGENTS.md](./AGENTS.md) for the repository contract and architecture notes.

## Install

```bash
npm install @berry-agent/core @berry-agent/models
```

Add packages as needed:

```bash
npm install @berry-agent/tools-common @berry-agent/safe @berry-agent/mcp
npm install @berry-agent/prompt-pack @berry-agent/observe @berry-agent/team
```

## Packages

| Package | Purpose |
| --- | --- |
| `@berry-agent/core` | Agent loop, sessions, provider adapters, compaction, event log, skills, workspace layout |
| `@berry-agent/models` | Model/provider registry, tier resolution, pricing helpers |
| `@berry-agent/tools-common` | Common file, shell, search, web, memory, and runtime tools |
| `@berry-agent/safe` | Tool safety policy, guard decisions, ask/deny lists |
| `@berry-agent/mcp` | MCP server config and MCP-to-Berry tool adapter |
| `@berry-agent/memory-file` | File-backed durable memory provider |
| `@berry-agent/prompt-pack` | Built-in and user-imported prompt packs |
| `@berry-agent/observe` | Cost, usage, cache, guard, and inference observability |
| `@berry-agent/team` | Multi-agent team/worklist primitives |
| `@berry-agent/avatar` | Deterministic pixel avatar generation |
| `@berry-agent/config` | Shared config loading helpers |

## Quick Start

```ts
import { Agent, AgentHome, FileEventLogStore } from '@berry-agent/core';

const home = new AgentHome('./.berry/orange');

const agent = Agent.create({
  home,
  providerType: 'openai',
  apiKey: process.env.OPENAI_API_KEY!,
  model: 'gpt-5.5',
  reasoningEffort: 'high',
  promptPack: 'berry-default-zh',
  eventLogStore: new FileEventLogStore(home.sessionsDir),
});

const result = await agent.send('Read the project and summarize the next safe step.');
console.log(result.message);
```

For production hosts, provide a model registry, a tool guard, and an event log store. The event log is not a replacement for provider context; it is the durable product/audit timeline.

## Prompt Packs

`@berry-agent/prompt-pack` ships three built-ins:

- `berry-default-zh`: default long-running tool agent behavior
- `berry-codex-zh`: engineering execution behavior
- `berry-claude-zh`: careful research and collaboration behavior

Prompt packs cover:

- base agent behavior
- compaction system prompt
- compaction summary prompt
- handoff/resume wrapper
- pre-compact durable-memory flush prompt

Hosts can seed and manage a prompt-pack directory:

```ts
import {
  ensurePromptPackDirectory,
  listPromptPacks,
  importPromptPack,
  exportPromptPack,
} from '@berry-agent/prompt-pack';

const promptPackDir = './.berry/prompt-packs';

ensurePromptPackDirectory({ directory: promptPackDir });
console.log(listPromptPacks({ directory: promptPackDir }));

importPromptPack('./my-pack', { directory: promptPackDir, overwrite: false });
exportPromptPack('berry-default-zh', './exported/default', { directory: promptPackDir });
```

Directory shape:

```text
prompt-packs/
└── packs/
    └── <pack-id>/
        ├── prompt-pack.json
        ├── base-agent.md
        ├── compact-system.md
        ├── compact-summary.md
        ├── handoff-resume-prefix.md
        ├── handoff-resume-suffix.md
        └── memory-flush.md
```

## Context And Durability

Berry Agent uses two explicit facts sources:

- `messages.json`: canonical input for every provider call. The SDK writes the turn into messages first, then reads messages back to build the LLM request.
- `events.jsonl`: append-only timeline for UI, audit, crash recovery, and product history.

Compaction rewrites provider context, but it does not erase the audit timeline. Product clients should render history from events, not from compacted messages.

## Development

```bash
npm install
npm run build
npm test
```

Package dry-run:

```bash
npm pack --dry-run --workspaces
```

## Status

Alpha. APIs are intentionally moving quickly while the SDK and Berry Claw product converge on the same runtime contract.
