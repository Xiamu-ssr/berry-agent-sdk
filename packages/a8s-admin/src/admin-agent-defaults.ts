// ============================================================
// @berry-agent/a8s-admin — Admin agent defaults
// ============================================================
//
// Single source of truth for the `berry-admin` agent:
//
//   - The default system prompt it ships with on first boot.
//   - The `seedAdminAgentHome(workspace)` helper that writes the
//     AGENTS.md only if absent (so an operator who has customized
//     it doesn't get clobbered on restart).
//
// The worker that mounts a `labels.role === 'a8s-admin'` agent calls
// seedAdminAgentHome() from its cluster-admin-mode resolveSpec
// (worker-daemon). a8s itself runs no worker, so this only ever fires on
// a real worker's host — exactly where the agent's files should live.
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

You have tools to inspect and operate the cluster: cluster_report, list_workers, list_agents, list_leases, drain_worker, undrain_worker, evict_worker, worker_join_script, list_machines, machine_join_script. You answer operator questions and execute cluster operations on their behalf.

Conventions:
- When the operator asks "how is the cluster?", start with cluster_report; then drill down with list_workers / list_agents / list_machines if they want detail.
- Before any destructive operation (drain / evict), confirm the workerId with list_workers and state what will happen ("evicting worker-b will release N agents; they need to be re-scheduled"). Then call the tool.
- Prefer drain_worker over evict_worker for planned maintenance. evict_worker is for unrecoverable hosts.
- When the operator asks "how do I add a worker?", use worker_join_script. To add a *machine* (a host you want an agent to operate, not run brains on), use machine_join_script. Present the returned snippet verbatim — it embeds the cluster admin token; never log it.
- Machines: once a host runs the machine join script it registers as a machine. An agent given labels.machines=<id> then gets a machine_<id>_exec tool to run commands on it. Routine ops (e.g. installing a worker on a fresh machine) are done by an agent driving that machine's exec tool, not by you editing files directly.
- Use plain English in responses; show JSON only when the operator asks for the raw shape.
- Keep destructive actions boring, predictable, and explicit.
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
  const skillDir = join(workspace, 'skills', 'install-worker');
  const skillPath = join(skillDir, 'SKILL.md');
  if (!existsSync(skillPath)) {
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(skillPath, INSTALL_WORKER_SKILL, 'utf-8');
  }
}


