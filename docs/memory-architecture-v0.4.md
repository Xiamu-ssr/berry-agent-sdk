# Memory Architecture v0.4

> Status: design draft (2026-04-20)
> Superseded docs: none (previous `@berry-agent/memory` package was removed)

## Why this exists

v0.3 hard-coded `memory_read` / `memory_write` tools into `@berry-agent/core`
via `runtime-tools.ts`. Those tools assume "memory = one text file,
read / append / replace". That assumption is wrong for:

- **mem0** — fact triples + semantic recall, not a blob
- **zep** — temporal knowledge graph, not a blob
- **Hermes-style frozen snapshot** — not retrievable at all, lives in system prompt
- **Hybrid vector+FTS over MEMORY.md** — can retrieve, but needs a search tool
  (`memory_search`) that doesn't exist in core today

If we keep the v0.3 shape, every new memory backend has to shoehorn itself
into a read/write interface it doesn't want. We close off the design space.

v0.4 pulls memory out of core and makes it a **pluggable provider**.

## Design principles

### 1. Core does not know how memory is stored or searched

- `@berry-agent/core` defines a `MemoryProvider` interface and optional
  `MemorySearchProvider` mixin. Nothing else.
- Core never reads `MEMORY.md`. Core never indexes anything.
- Core never registers a `memory_*` tool automatically.

### 2. File convention is a *user-layer* contract, not a core feature

- `MEMORY.md` + `memory/YYYY-MM-DD.md` is the filesystem convention shared
  with OpenClaw and Hermes. It **may** be referenced from system prompts or
  agent bootstrap text (user-authored).
- That convention is *not* wired into core logic. A file-backed provider
  implements it. Other providers (mem0, zep) ignore it.

### 3. Each provider owns its own tools

- `@berry-agent/memory-file` registers `memory_search`, `memory_get`,
  `memory_write` (file-based)
- `@berry-agent/memory-mem0` registers whatever mem0's native verbs are
  (`memory_add`, `memory_search`, `memory_get_all`, …)
- Consumers pick **one** provider per agent. Tool surface changes with the
  pick. This is intentional: giving the agent two concurrent memory tools
  from two providers is a footgun.

### 4. The read/write abstraction stays — for backward compatibility only

`runtime-tools.ts`'s `memory_read` / `memory_write` remain in core for one
release, marked `@deprecated`. They work only if the consumer explicitly
opts in via `memory: { legacy: true }` or similar. New consumers use
providers.

## Package layout

```
@berry-agent/core
  └── memory/
      ├── provider.ts       // MemoryProvider interface
      ├── search.ts         // MemorySearchProvider interface
      └── index.ts          // types only, no impl

@berry-agent/memory-file    // local MEMORY.md + memory/*.md
  ├── chunker.ts            // chunkMarkdown (400 tok / 80 overlap)
  ├── tokenize.ts           // ASCII + CJK bigram tokenizer
  ├── fts.ts                // SQLite FTS5 backend
  ├── vector.ts             // v0.4+: cosine + embedding client
  ├── hybrid.ts             // v0.4+: weighted fusion + MMR
  ├── store.ts              // better-sqlite3 wrapper
  ├── tools.ts              // registers memory_search / memory_get / memory_write
  └── index.ts              // createFileMemoryProvider(options)

@berry-agent/memory-mem0    // future, v0.5+
@berry-agent/memory-zep     // future, v0.5+
```

## Core types (`@berry-agent/core/memory`)

```ts
export interface MemoryProvider {
  /** Unique id, used for debug logs */
  readonly id: string;

  /** Tools this provider contributes to the agent */
  tools(): ToolRegistration[];

  /**
   * Optional startup hook. Index builds, sqlite opens, embedding warmups.
   * Agent won't run queries until this resolves.
   */
  init?(ctx: MemoryInitContext): Promise<void>;

  /** Optional teardown hook */
  dispose?(): Promise<void>;
}

export interface MemoryInitContext {
  agentId: string;
  workspaceDir: string;      // where MEMORY.md lives
  dataDir: string;           // where the provider may put its sqlite / cache
}

/**
 * Separate capability so providers can indicate "I can search"
 * without forcing the MemoryProvider base to have search semantics.
 * Mem0 has search; frozen-snapshot providers do not.
 */
export interface MemorySearchProvider {
  search(query: string, options?: MemorySearchOptions): Promise<MemorySearchResult[]>;
}

export interface MemorySearchOptions {
  maxResults?: number;
  minScore?: number;
}

export interface MemorySearchResult {
  id: string;
  path: string;
  startLine: number;
  endLine: number;
  score: number;
  textScore?: number;
  vectorScore?: number;
  snippet: string;
  source: 'memory';
  citation: string;          // "path#L1-L10"
}
```

## Tool contract — inherited from OpenClaw

Decision: we adopt OpenClaw's `memory_search` / `memory_get` input/output
shape almost verbatim, minus the fields we don't need.

```ts
// memory_search input
{ query: string; maxResults?: number; minScore?: number }

// memory_search output (top-level)
{
  results: MemorySearchResult[];
  provider: 'none' | 'openai' | 'local' | ...;
  debug: { backend: 'fts' | 'hybrid'; searchMs: number; hits: number };
}

// memory_get input
{ path: string; from?: number; lines?: number }

// memory_get output
{ text: string; path: string; from: number; to: number; truncated: boolean }
```

Fields we deliberately drop vs OpenClaw:

- `corpus` (wiki / all) — we don't have a wiki subsystem
- `citations` mode — citations are always on
- `source: 'sessions'` — transcript indexing is not in v0.4

## @berry-agent/memory-file scope

### v0.4.0 (the "today" target)

- `chunkMarkdown` — port verbatim from OpenClaw `internal-DHMTwtHq.js`
  (char-based estimator, `tokens*4` window, CJK surrogate-pair aware)
- `tokenize` — ASCII lowercase + CJK bigram + CJK unigram, returns `Set<string>`
  (OpenClaw's exact algorithm, relevant for MMR only when we enable it)
- `SQLite FTS5` — single file at `${dataDir}/memory/${agentId}.sqlite`
- **Nothing vector**. `provider: 'none'`.
- `memory_search` and `memory_get` tools
- Optional `memory_write` that appends to MEMORY.md (opt-in, so agents that
  want "write via ordinary `write_file` tool" can skip it)

### v0.4.1+

- Embedding client (OpenAI, Ollama/local)
- `sqlite-vec` extension for vector column
- Hybrid search with the exact OpenClaw weights (0.7/0.3, 4x candidates,
  optional MMR with λ=0.7, optional temporal decay with 30d half-life)
- Temporal decay regex for `memory/YYYY-MM-DD.md`
- Dated-memory directory awareness

## Default values (inherited from OpenClaw memory_search)

| Constant | Value | Source |
|---|---|---|
| chunkTokens | 400 | `DEFAULT_CHUNK_TOKENS` |
| chunkOverlap | 80 | `DEFAULT_CHUNK_OVERLAP` |
| maxResults | 6 | `DEFAULT_MAX_RESULTS` |
| minScore | 0.35 | `DEFAULT_MIN_SCORE` |
| vectorWeight | 0.7 | `DEFAULT_HYBRID_VECTOR_WEIGHT` (v0.4.1+) |
| textWeight | 0.3 | `DEFAULT_HYBRID_TEXT_WEIGHT` (v0.4.1+) |
| candidateMultiplier | 4 | `DEFAULT_HYBRID_CANDIDATE_MULTIPLIER` (v0.4.1+) |
| mmrEnabled | false | `DEFAULT_MMR_ENABLED` (v0.4.1+) |
| mmrLambda | 0.7 | `DEFAULT_MMR_LAMBDA` (v0.4.1+) |
| temporalDecayEnabled | false | `DEFAULT_TEMPORAL_DECAY_ENABLED` (v0.4.1+) |
| temporalDecayHalfLifeDays | 30 | `DEFAULT_TEMPORAL_DECAY_HALF_LIFE_DAYS` (v0.4.1+) |

All constants cross-checked against
`node_modules/openclaw/dist/memory-search-ABYPOqC9.js` on 2026-04-20.

## Migration path for core

1. **v0.4.0-alpha.0**: ship `@berry-agent/memory-file` alongside existing
   `runtime-tools.ts` memory_{read,write}. Both work.
2. **v0.4.0**: `runtime-tools.ts` memory tools emit a `console.warn` once per
   process when used without the new provider being installed.
3. **v0.5.0**: remove `runtime-tools.ts` memory tools. Consumers must attach
   a `MemoryProvider` to get memory capability.

`todo_read` / `todo_write` stay in core permanently — they don't have the
pluggability problem memory has, because todos are session-scoped ephemeral
state, not a cross-session store.

## Open questions

1. **Do we want an `@berry-agent/memory` meta-package?**
   Something that re-exports `-file` by default for the common case. Leaning
   yes but not urgent — consumers can `npm i @berry-agent/memory-file` directly.

2. **How does the Agent config reference a provider?**
   Options:
   - `new Agent({ memory: createFileMemoryProvider({...}) })` — import-based,
     explicit, typesafe. Prefer this.
   - `new Agent({ memory: { type: 'file', options: {...} } })` — config-blob,
     avoids import. Harder to type.
   We'll go with import-based. berry-claw's config layer can still accept
   strings and resolve them to imports itself.

3. **mem0 has `user_id`. File memory doesn't. How does the provider interface
   express "this provider is per-user" vs "per-agent"?**
   Kick this to v0.5 when we actually do mem0.

4. **Embedding cost control.**
   When v0.4.1 lands, a large MEMORY.md triggers a full re-embed on startup.
   Need either incremental index or a content hash cache. OpenClaw does hash
   caching (`hashText` in `internal-DHMTwtHq.js`). Adopt the same.

## References

- OpenClaw memory-search defaults: `node_modules/openclaw/dist/memory-search-ABYPOqC9.js`
- OpenClaw hybrid merge + MMR: `node_modules/openclaw/dist/manager-cQ8cHF3H.js`
- OpenClaw chunkMarkdown + tokenize: `node_modules/openclaw/dist/internal-DHMTwtHq.js`
- OpenClaw memory-core tool: `node_modules/openclaw/dist/extensions/memory-core/index.js`
- Live tool output observed via `memory_search` call 2026-04-20: provider=`none`,
  backend=`builtin` (FTS-only; embedding never configured)
