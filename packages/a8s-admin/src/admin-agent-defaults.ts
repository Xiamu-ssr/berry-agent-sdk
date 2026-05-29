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
// Both bootstrap paths import from here:
//
//   - `a8s-server` ensureLocalWorker → in-process worker mount.
//   - `worker-daemon` cluster-admin-mode → HTTP-attached worker mount.
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
 * Synchronous seed: write the default AGENTS.md only if the file does
 * not already exist. Sync on purpose so callers can use it from the
 * worker daemon's `resolveSpec` (a synchronous hook).
 *
 * `workspace` is the agent home directory (typically
 * `<agentsRoot>/berry-admin`). Created if absent — this runs from the
 * worker's resolveSpec, before the runtime builder initializes the home.
 */
export function seedAdminAgentHome(workspace: string, prompt: string = DEFAULT_ADMIN_SYSTEM_PROMPT): void {
  const agentMdPath = join(workspace, 'AGENTS.md');
  if (existsSync(agentMdPath)) return;
  mkdirSync(workspace, { recursive: true });
  writeFileSync(agentMdPath, prompt, 'utf-8');
}
