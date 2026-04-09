# Berry Agent SDK v0.1 Roadmap

## Positioning

Berry Agent SDK is a **pure-library agent core**.

It is meant to provide the minimum serious substrate for building higher-level claw-like runtimes:

- agent loop
- session management
- compaction
- cache strategy
- tools
- streaming/events
- multi-provider support

It is **not** trying to become a full product runtime yet.

---

## Alpha: what already exists

### Core runtime
- Agent query loop
- tool execution loop
- per-query allowed tools
- session resume / fork

### Providers
- Anthropic provider
- OpenAI-compatible provider
- streaming support on both

### Context management
- batch compaction pipeline
- cache-aware Anthropic prompt shaping
- cache-friendly OpenAI-compatible prompt shaping

### Persistence
- in-memory session store
- file-backed JSON session store

### Observability
- query lifecycle events
- text deltas
- thinking deltas
- tool events
- compaction events

### Delivery
- npm alpha published
- GitHub repo published

---

## Immediate next steps

### 1. Correctness / validation
- run real smoke tests against Anthropic and OpenAI-compatible endpoints
- deepen streaming/provider edge-case tests
- verify usage / stopReason behavior under streaming

### 2. Example usability
- make examples copy/paste runnable
- document env variables clearly
- keep the example surface small and obvious

### 3. Documentation cleanup
- tighten README/API surface
- document what is stable vs experimental
- make it easier for the first external consumer to adopt

---

## Intentionally out of scope for now

These are deferred on purpose:

- MCP
- sandbox / permissions
- memory system
- channel integrations
- multi-language bindings
- large runtime surface area

The goal is to keep Berry focused as a reusable core, not let it sprawl into a monolith too early.

---

## First consumer strategy

The first consumer should be a **minimal claw-like product** built on top of Berry.

The point is not to build a complete platform immediately.
The point is to prove:

1. Berry's core abstractions are sufficient
2. the SDK is ergonomic enough for a real consumer
3. missing pieces are identified by real usage, not speculation

---

## Exit criteria for v0.1 alpha

Berry v0.1 alpha is in a good place when:

- both providers pass real smoke tests
- examples are easy to run
- unit tests cover streaming/provider boundaries better
- README explains the mental model clearly
- one real consumer starts depending on it
