# Hands, Tools, Execution Environments — and the machine layer

> Status: design note, settled through the 2026-05-29 architecture discussion.
> This is the conceptual contract behind `@berry-agent/core` hands +
> execution-environment and the planned multi-machine work. `AGENTS.HTML`
> remains the current-state package map; this file explains the *why* and
> the direction for machines.

## Three layers, do not conflate them

The single most common confusion (we hit it repeatedly) is collapsing
"a capability" and "where it runs". Berry keeps them apart:

| Layer | What it is | Kitchen analogy | Code |
|---|---|---|---|
| **Tool** | one capability, holds an executor reference | a dish's recipe | `ToolRegistration` |
| **Hand** | a *bundle* of tools + routing | menu + waiter | `Hand` (`hands.ts`) |
| **ExecutionEnvironment** | the physical/isolated place commands land | the kitchen | `ExecutionEnvironment` (`execution-environment.ts`) |

This is exactly Anthropic's 4+1 split of **Tools** vs **Sandbox**, and the
split is load-bearing, not decorative: it is what lets "brain in cloud,
hand on a local machine" be legal. Merge them and you lose the ability to
run the same capability set on a different machine without redefining it.

## The direction that matters: Environment *produces* Hand

The relationship is **not** "configure an Environment into a Hand, then
plug the Hand into the brain." It is the reverse, and the code is explicit
(`runtime/build.ts`):

```ts
hands.push(...(executionEnvironment.createHands(scope)));
```

> **Environment is the factory. Hand is the product.** A machine
> (Environment) calls `createHands()` and emits a Hand welded to itself.
> The Hand holds one *pipe* (a `CommandExecutor`) back to that factory —
> it does not *own* the factory.

Why this direction is the whole point:

- **If Hand contained Environment** → every Hand you add needs an
  environment configured into it. N agents × M hands = configuration
  explosion. This is the "maintenance disaster" worry, and it would be
  real.
- **Because Environment produces Hand** → you configure a *machine once*;
  the machine hands out Hands with the correct executor already welded in.
  An agent that wants the machine receives its Hand with **zero
  per-tool, per-agent wiring**.

**The unit you manage is the machine/environment — never the individual
tool.** The tool↔executor binding is done automatically inside
`createHands`; you never touch it. The brain, in turn, is almost blind to
environments: it sees a list of Hands (`machine-b.shell`,
`cluster-admin.list_workers`) and does not know or care which pipe sits
behind each. That blindness is the payoff of "Hand config is not bound to
a machine."

Corrected mental model:

> **Hand = a bundle of tools + one pipe to an execution point. The pipe is
> welded by the Environment when it produces the Hand. You manage
> machines; Hands are their automatic output.**

## Hand does not "execute" — it routes

A second naming trap: "how can a Hand execute?" It doesn't. `Hand.execute`
just forwards to the tool's own `execute` (`hands.ts`):

```ts
execute: async (call, context) => {
  const tool = byName.get(call.capabilityId);
  return await tool.execute(call.input, context); // the only work: delegate
}
```

The tool itself holds the executor (for shell/file tools) or simply makes
an HTTP/in-memory call (for API tools). So:

- **Shell / file / search / process tools** carry a `CommandExecutor`.
  That executor is what an Environment swaps to change *where* the command
  lands (local sandbox / container / remote machine / polling host).
- **API/state tools** (cluster-admin's `list_workers`, team's
  `message_leader`) hold no executor and touch no Environment. Forcing
  every tool through an Environment would be over-abstraction.

Judgement rule for "does this tool need an Environment":

- Effect lands on **some machine's OS / filesystem** → yes, must go through
  that machine's Environment executor.
- Effect is **call an API / mutate memory** → no, executes in the brain
  process directly.

## Two safety layers, distinct, do not merge

"Refusing to execute" does **not** live in the ExecutionEnvironment.
(`runtime/build.ts` wires a separate guard.)

| Layer | Where | Governs |
|---|---|---|
| `ManagedToolGuard` (`@berry-agent/safe`) | gate *before* a tool call | "is this action allowed" — allowlist / approval / classifier. **This is the refusal.** |
| `ExecutionEnvironment.isolationPolicy` | the environment's own boundary | "what paths/network this environment can touch" — physical isolation, not a decision |

For a machine Hand both apply: coarse physical isolation on the
Environment (this machine may only touch `/var/berry`), fine-grained
"is this command allowed" on the guard.

## Implicit contracts to fix when building the machine layer

These are real, currently-implicit behaviors that must become explicit so
the machine layer is safe:

1. **No silent local-executor fallback.** Today a shell tool with no
   injected executor defaults to `NodeExecutor` (bare `child_process`, no
   sandbox, runs on the brain's own host) — see `local-tools.ts` +
   `shell.ts`. A remote machine Hand must **fail closed** if it cannot bind
   its machine's executor, never fall back to local.
2. **Local bare execution must be named, not default.** The executor
   should be explicit; "I have no sandbox" should be a visible choice
   (`NodeExecutor`), not the absence of configuration.
3. **Not all tools go through an Environment** (see judgement rule above).

## Machine layer: the settled design

Decisions locked in the discussion:

- **Each machine = one ExecutionEnvironment** that `createHands()` → **one
  exec/file Hand** welded to that machine.
- An agent operating two machines simply receives **two Hands**. "Select a
  Hand = select a machine" is literal.
- Machine Hands attach via the **additional-hand channel** (the same way
  `hostHand` already adds cluster-admin tools today — `build.ts` proves a
  brain already holds multiple hands). The runtime keeps **one primary
  Environment** (where the brain itself runs); machines are extra hands it
  can reach. We do **not** pluralize the core `executionEnvironment` into a
  set — that is a large surgery for a symmetry (brain itself migrating to a
  remote machine) we explicitly don't need in alpha.
- **"Install a worker" is a skill, not a fixed connector RPC.** The old
  plan (a connector exposing `install_worker`/`restart`/… as fixed
  endpoints) is an anti-pattern: a fixed command menu is exactly the
  inflexibility we're escaping. Instead the machine Hand exposes *generic*
  exec/file; the agent reads a skill and composes the commands itself.
  This retires the original F6 (worker-daemon admin endpoints).

Transport: reuse the worker pattern — the machine endpoint dials out and
registers (callbackUrl + token); a8s calls back. Not peer-to-peer; the
managed side reaches out first, the manager records the return path.

## The three pools (Environment / Hand / blueprint)

The intuition that a8s should have reusable "markets" is sound, but the
reuse granularity differs by kind:

| Pool | Reuses | Like | State |
|---|---|---|---|
| **Environment pool** | a machine / container recipe (isolation, installed runtime) | "where it runs" presets | stateless ✓ reusable |
| **Hand pool** | a capability bundle (cluster-admin 8-pack, team kit, a machine's exec kit) | capability market | stateless ✓ reusable |
| **Agent blueprint pool** | a *starting recipe* (system prompt + selected hands + env recipe) | "new app from template" | recipe stateless ✓; instantiated session is fresh |

Key relationships:

- The Environment pool is **contained by** the Hand pool for machine-type
  hands: registering a machine into the Environment pool simultaneously
  lists its exec capability in the Hand pool. But the Hand pool is
  **larger** — it also holds **environment-less Hands** (cluster-admin,
  team, MCP) that come from no machine.
- **Session is NOT a pool.** Sessions are stateful history
  (`messages.json` + `events.jsonl`) living under the machine-scoped agent
  home (`/var/berry/agents/<id>/sessions/...`). Sharing a session instance
  = identity confusion + two brains contending one lease (forbidden by the
  lease-single-holder principle). What you *can* reuse is the **starting
  recipe** → that's the Agent blueprint pool, which instantiates a fresh,
  independent session each time. **The market sells recipes (blueprints),
  not save-files (session instances).**

Today's `labels.role=a8s-admin` → cluster-admin injection is already a
primitive version of the Hand pool (pick capabilities by label). Pools
(registry + UI selection) are a natural increment on top of the machine
layer, not a prerequisite. Building the machine layer lays the first slab
of the Environment pool and Hand pool for free.

## Open / next (not yet settled)

- **Reverse Hand: local machine supplies a Hand to a cloud a8s.** The
  primitive exists — `PollingExecutionEnvironment` (`polling-environment.ts`):
  the capability host (e.g. a Mac behind a firewall) dials out and polls; no
  inbound port. So a local Mac need not be a worker — it can be a pure
  *capability provider* (a reverse Environment). The capability list is
  declared **by the local host itself** (it reads its own `.mcp.json`,
  starts its own MCP servers, exposes its own browser) — **not preset in
  the SDK, not defined in a8s**. SDK ships only generic primitives; the
  concrete local capabilities are the local host's to declare. Caveat:
  polling env currently supports `exec()` but throws on `spawn()` — long-
  lived processes over polling need follow-up. Details deferred to the next
  session.
- **Pool registries + UI** (Environment pool / Hand pool / blueprint pool
  as first-class managed objects). Increment on the machine layer.
- **A8S Engine as a product on the A8S infra**: "install A8S Engine" =
  schedule berry-admin (already shipped as `POST /v1/operator/admin-agent`
  + the Settings button). The front-end fuses infra + Engine into one UI;
  conceptually they stay distinct.
