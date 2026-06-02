// ============================================================
// @berry-agent/a8s-admin — Admin agent defaults
// ============================================================
//
// Single source of truth for the `berry-admin` agent:
//
//   - The default system prompt it ships with on first boot.
//   - The `a8s-ops` and `install-worker` skills (knowledge layer).
//   - The `seedAdminAgentHome(workspace)` helper that writes the AGENTS.md
//     and the skills, each only if absent (so an operator who has
//     customized them doesn't get clobbered on restart).
//
// The worker that mounts a `labels.role === 'a8s-admin'` agent calls
// seedAdminAgentHome() from its admin-ops-mode resolveSpec (worker-daemon).
// a8s itself runs no worker, so this only ever fires on a real worker's
// host — exactly where the agent's files should live.
//
// Keeping the prompt + the seed call here is what removes the second
// fact source we used to have in `bootstrap.ts`.

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Default AGENTS.md content for berry-admin. Spelled out here so a
 * fresh deploy doesn't need a skill / template package just to boot
 * the admin agent.
 */
export const DEFAULT_ADMIN_SYSTEM_PROMPT = `You are berry-admin, the cluster operator for this a8s control plane.

You operate the cluster by running the **berry-a8s-ops** CLI through your
shell. It is preinstalled and already authenticated (the a8s URL + admin
token are in your environment). Run \`berry-a8s-ops --help\` to see every
command. You also have an \`a8s-ops\` skill that documents the common
workflows — consult it when the operator asks you to do something.

Conventions:
- When the operator asks "how is the cluster?", run \`berry-a8s-ops cluster\`;
  then drill down with \`workers\` / \`agents\` / \`machines\` if they want detail.
- Before any destructive operation (\`drain\` / \`evict\`), run \`berry-a8s-ops workers\`
  to confirm the workerId and state what will happen ("evicting worker-b will
  release N agents; they need to be re-scheduled"). Then run the command.
- Prefer \`drain\` over \`evict\` for planned maintenance. \`evict\` is for
  unrecoverable hosts.
- To add a worker, run \`berry-a8s-ops join-script\`; to add a *machine* (a host
  you want an agent to operate, not run brains on), run
  \`berry-a8s-ops machine-join-script\`. Present the returned snippet verbatim —
  it embeds the cluster admin token; never log it or echo your own token.
- Machines: once a host runs the machine join script it registers as a machine.
  An agent given labels.machines=<id> then gets a machine_<id>_exec tool to run
  commands on it. Routine ops (e.g. installing a worker on a fresh machine) are
  done by an agent driving that machine's exec tool — see the install-worker skill.
- Use plain English in responses; show raw JSON only when asked (\`--json\` flag).
- Keep destructive actions boring, predictable, and explicit.
`;

/**
 * The `a8s-ops` skill — how berry-admin operates the cluster through the
 * `berry-a8s-ops` CLI. This is the knowledge half of 新-2: cluster ops are
 * documented here (knowledge layer) and executed via the CLI through a
 * generic shell Hand (execution layer), instead of being hardcoded tools.
 * Seeded into the admin agent's skills dir on first boot.
 */
export const A8S_OPS_SKILL = `---
name: a8s-ops
description: Operate the a8s cluster — inspect status, manage workers, add workers/machines — using the berry-a8s-ops CLI.
whenToUse: When the operator asks about cluster status or capacity, or wants to drain/undrain/evict a worker, add a worker, or add a machine — "how is the cluster?", "drain worker-b", "add a worker", "what machines do I have?".
---

# Operate the a8s cluster with berry-a8s-ops

You operate the cluster by running the **berry-a8s-ops** CLI in your shell.
It is preinstalled and authenticated from your environment (BERRY_A8S_URL +
BERRY_A8S_ADMIN_TOKEN) — you don't pass credentials yourself. Run
\`berry-a8s-ops --help\` to see everything. Add \`--json\` to any read command
to get the raw shape instead of a summary.

## Read the cluster

- \`berry-a8s-ops cluster\` — one-line health: worker counts, capacity, agents, uptime. Start here.
- \`berry-a8s-ops workers\` — every worker: state, used/capacity, labels. Use before drain/evict.
- \`berry-a8s-ops agents\` — which agent is assigned to which worker.
- \`berry-a8s-ops leases\` — durable lease table (agent → worker bindings). Use to debug stuck/expired leases.
- \`berry-a8s-ops machines\` — registered machines (the machine layer) + how many MCP tools each proxies.

## Manage worker lifecycle

- \`berry-a8s-ops drain <workerId>\` — stop scheduling new agents onto it; current agents keep running. Reversible. Use before planned maintenance.
- \`berry-a8s-ops undrain <workerId>\` — re-enable a drained worker.
- \`berry-a8s-ops evict <workerId>\` — **destructive**: hard-remove a worker, release its leases. Agents on it stop until rescheduled. Only for unrecoverable hosts.

**Before any drain/evict**: run \`berry-a8s-ops workers\` first, confirm the
id, and tell the operator what will happen (how many agents move). Prefer
\`drain\` over \`evict\` for anything planned.

## Grow the cluster

- \`berry-a8s-ops join-script\` — prints a bash snippet the operator pastes on a NEW host to install + start a worker that joins this cluster.
- \`berry-a8s-ops machine-join-script\` — prints a snippet to install a *machine connector* on a host (so an agent can operate it via a machine exec tool, without running brains there).

Both snippets **embed the cluster admin token**. Present them verbatim to the
operator and tell them to treat the output as a secret. Never echo your own
token (\`echo $BERRY_A8S_ADMIN_TOKEN\`) into a response or a log.

## After adding a machine

Installing a worker *on* a registered machine is itself an agent task — see
the \`install-worker\` skill, which drives that machine's exec tool.
`;

/**
 * The "install a worker on a machine" skill. Shipped as content (not a
 * tool) because it IS the design point: installing a worker is something
 * the agent does by driving a machine's generic exec tool, not a fixed
 * connector RPC. Seeded into the admin agent's skills dir on first boot.
 */
export const INSTALL_WORKER_SKILL = `---
name: install-worker
description: Install and start a berry worker on a machine you have exec access to, so it can host agent brains.
whenToUse: When the operator wants to add worker capacity on a registered machine — "install a worker on machine X", "turn host Y into a worker", "we need more capacity".
---

# Install a worker on a machine

You install a worker by **driving the target machine's exec tool**
(\`machine_<id>_exec\`). There is no special "install worker" command — the
machine is a generic execution surface and you compose ordinary shell
steps. This is deliberate: it keeps machines flexible (the connector has
no fixed menu) and keeps the install logic here, where it can evolve
without redeploying anything.

## Preconditions

1. The target host must already be a registered machine. Run \`list_machines\`
   and confirm the machine is \`active\`. If it isn't, the operator must add
   it first (\`machine_join_script\` → they run the snippet on that host).
2. You must have the machine's exec tool. If you don't see
   \`machine_<id>_exec\` in your tools, you weren't granted that machine —
   ask the operator to create/grant an agent with \`labels.machines\`
   including this id.

## Steps

Use \`machine_<id>_exec\` for every command below. Substitute the real
machine id. Pick a stable WORKER_ID (often the machine's hostname).

1. **Check the toolchain** — confirm node + npm exist:
   \`node --version && npm --version\`
   If missing, install Node ≥20 first (the method depends on the host's
   package manager — \`apt\`, \`brew\`, \`dnf\`, …; inspect with \`uname -a\`
   and \`cat /etc/os-release\` when unsure).

2. **Install the worker daemon** globally:
   \`npm install -g @berry-agent/worker-daemon\`

3. **Prepare the data + agents roots**:
   \`mkdir -p /var/berry/workers/<WORKER_ID> /var/berry/agents\`

4. **Write the worker config**. Keep \`"registry": null\` so the worker
   pulls the cluster-wide models template from a8s at registration — do
   NOT paste API keys into this file. Fill A8S_URL and ADMIN_TOKEN from
   what the operator provides (the same a8s URL + admin token the machine
   connector itself uses):
   \`\`\`
   cat > /var/berry/workers/<WORKER_ID>/worker.json <<'JSON'
   {
     "workerId": "<WORKER_ID>",
     "port": 7100,
     "a8s": "<A8S_URL>",
     "adminToken": "<ADMIN_TOKEN>",
     "capacity": 4,
     "heartbeatTtlMs": 30000,
     "dataRoot": "/var/berry/workers/<WORKER_ID>",
     "agentsRoot": "/var/berry/agents",
     "registry": null
   }
   JSON\`\`\`

5. **Start it** (prefer a process manager so it survives reboots; a bare
   start is fine for a first smoke test):
   \`berry-worker start --config /var/berry/workers/<WORKER_ID>/worker.json\`
   For production, install a systemd unit with \`Restart=always\` instead.

6. **Verify** with \`list_workers\` — the new worker should appear \`active\`
   with the capacity you set. If it doesn't within ~30s, re-run step 5 in
   the foreground and read the output: the most common failure is a8s
   having no models template yet (configure it in Settings → Models).

## Notes

- The worker pulls the models template at register time. If the operator
  hasn't configured one, the worker starts but can't mount agents that
  need an LLM. Tell them to set it first.
- Never echo the admin token into logs. When you must show progress,
  redact it.
`;

/**
 * Synchronous seed: write the default AGENTS.md and the install-worker
 * skill, each only if absent (so an operator who customized them isn't
 * clobbered on restart). Sync on purpose so callers can use it from the
 * worker daemon's `resolveSpec` (a synchronous hook).
 *
 * `workspace` is the agent home directory (typically
 * `<agentsRoot>/berry-admin`). Created if absent — this runs from the
 * worker's resolveSpec, before the runtime builder initializes the home.
 */
export function seedAdminAgentHome(workspace: string, prompt: string = DEFAULT_ADMIN_SYSTEM_PROMPT): void {
  mkdirSync(workspace, { recursive: true });
  const agentMdPath = join(workspace, 'AGENTS.md');
  if (!existsSync(agentMdPath)) {
    writeFileSync(agentMdPath, prompt, 'utf-8');
  }
  seedSkill(workspace, 'a8s-ops', A8S_OPS_SKILL);
  seedSkill(workspace, 'install-worker', INSTALL_WORKER_SKILL);
}

/** Write a skill's SKILL.md under <workspace>/skills/<name>/, only if absent. */
function seedSkill(workspace: string, name: string, content: string): void {
  const skillDir = join(workspace, 'skills', name);
  const skillPath = join(skillDir, 'SKILL.md');
  if (!existsSync(skillPath)) {
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(skillPath, content, 'utf-8');
  }
}


