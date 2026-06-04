// ============================================================
// @berry-agent/a8s-admin — Collaboration skills (team / cluster)
// ============================================================
// Agent collaboration is *knowledge*, not a tool surface. a8s exposes only
// neutral primitives (spawn / send / list / snapshot / delete via the
// `berry-team` CLI); the *shape* of collaboration — hierarchical team vs.
// flat cluster — lives entirely in these skills. A product seeds the skill
// that matches the form it wants for a given agent:
//
//   - single agent  : seed neither.
//   - team          : seed TEAM_SKILL on the lead.
//   - agents cluster: seed CLUSTER_SKILL on every member.
//
// Both skills drive the same `berry-team` CLI. Adding a collaboration
// pattern = a new skill here, no a8s change.

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * TEAM_SKILL — hierarchical collaboration. A lead agent spawns teammates,
 * hands out work, and collects results. There IS an up/down relationship:
 * the lead owns the goal and decides; teammates execute focused subtasks.
 */
export const TEAM_SKILL = `---
name: team
description: Lead a team of agents — spawn focused teammates, delegate subtasks, collect and synthesize their results — using the berry-team CLI.
whenToUse: When a task is big enough to split across several agents under your direction — "build X with a frontend and backend part", "review this from three angles", "research these five topics in parallel". Use it when YOU are the lead deciding the plan.
---

# Lead a team with berry-team

You coordinate other agents by running the **berry-team** CLI in your shell.
It is preinstalled and authenticated from your environment. You are the
**lead**: you own the goal, split it into focused subtasks, spawn a teammate
per subtask, and synthesize their results. Teammates do not command you or
each other — the structure is one level deep (you → teammates).

## The loop

1. **Plan.** Break the goal into independent subtasks. One teammate per
   subtask, named for its job (\`reviewer-security\`, \`coder-api\`).
2. **Spawn** each teammate with a model and a \`team\` label so they're
   discoverable as yours:
   \`berry-team spawn <id> --model tier:strong --label team=<your-id> --label role=<job>\`
3. **Delegate** by sending each one a self-contained instruction (they don't
   share your context — include what they need):
   \`berry-team send <id> "Your task: ... . Report back: ... ."\`
   \`send\` blocks until that teammate finishes its turn and prints its reply.
4. **Synthesize.** Read the replies, resolve conflicts, produce the final
   result yourself. You are accountable for the whole.
5. **Disband** teammates you're done with: \`berry-team disband <id>\`.

## Conventions

- Keep teammates **focused** — one clear job each. A vague teammate wastes a turn.
- Always tell a teammate **what to report back** — you need a usable answer, not a log.
- Spawn only what you need; \`berry-team peers\` shows who's already around.
- A teammate is just an agent. It can have its own Hands (give it
  \`--label machines=<id>\` to operate a machine). It does not inherit yours.
- You decide; teammates execute. If a subtask needs its own sub-team, that
  teammate can lead one — but keep each level shallow.
`;

/**
 * CLUSTER_SKILL — flat collaboration, no hierarchy. Every member is a peer:
 * any agent may spawn more, broadcast to others, and claim shared work.
 * No lead, no up/down. Scales to many more agents than a team because no
 * single agent is a coordination bottleneck.
 */
export const CLUSTER_SKILL = `---
name: cluster
description: Collaborate as an equal peer in a flat agent cluster — spawn peers, broadcast, and claim shared work — using the berry-team CLI. No leader, no hierarchy.
whenToUse: When you're one of many peer agents working a shared goal with no one in charge — large parallel sweeps, swarm-style problem solving, "everyone grab an item and go". Use it when there is NO lead and you act as an equal.
---

# Collaborate in a flat cluster with berry-team

You are one **peer** among many. There is **no leader** — no agent commands
another. Every member can do the same things: discover peers, spawn more
peers, message anyone, and claim a piece of the shared work. Coordination is
emergent, not directed. This scales past what a single lead could manage,
because no one is a bottleneck.

## How peers coordinate (no boss)

- **Discover:** \`berry-team peers\` — see who's in the cluster.
- **Grow:** if there's more work than peers, \`berry-team spawn <id> --model <ref>
  --label cluster=<name>\` — anyone may add capacity.
- **Claim, don't assign:** pick an unclaimed item of the shared work and
  announce you're taking it before starting, so peers don't double-work:
  \`berry-team send <peer> "Claiming item #N — others skip it."\`
  (Broadcast by sending each peer, or post to the shared worklist if one exists.)
- **Ask a peer** for help or a result: \`berry-team send <id> "..."\` — it's a
  request between equals, not an order. Blocks until they reply.
- **Inspect:** \`berry-team status <id>\` to see a peer's model / hands / state.

## Conventions

- **No central plan.** Each peer takes responsibility for a slice and sees it
  through. Self-organize around the shared goal.
- **Avoid collisions** by claiming loudly before working.
- **Idempotent, independent slices.** Since there's no coordinator to retry,
  make your piece safe to redo and not dependent on a specific other peer.
- A peer is just an agent with its own Hands — spawn one with the Hands its
  slice needs (\`--label machines=<id>\` for machine access).
- When the shared goal is done, peers \`berry-team disband\` the helpers they
  spawned. Leave the cluster as you found it.
`;

/** All collaboration skills by name, for product-side seeding. */
export const COLLABORATION_SKILLS: Record<string, string> = {
  team: TEAM_SKILL,
  cluster: CLUSTER_SKILL,
};

/**
 * Seed a collaboration skill into an agent's home (only if absent, so a
 * customized copy isn't clobbered). Products call this when creating a team
 * lead (`'team'`) or a cluster member (`'cluster'`). The skill drives the
 * `berry-team` CLI; pair it with a generic shell Hand + the a8s credentials
 * in the agent's execution env (same env-injection the admin agent uses).
 */
export function seedCollaborationSkill(workspace: string, kind: 'team' | 'cluster'): void {
  const content = COLLABORATION_SKILLS[kind];
  if (!content) throw new Error(`unknown collaboration skill: ${kind}`);
  const dir = join(workspace, 'skills', kind);
  const path = join(dir, 'SKILL.md');
  if (existsSync(path)) return;
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, content, 'utf-8');
}
