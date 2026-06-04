// ============================================================
// @berry-agent/a8s-admin — Public API
// ============================================================
//
// Surfaces:
//
//   - `A8sOperatorClient` — typed HTTP client over /v1/operator/* +
//     admin-scope agent endpoints. Use directly from CLI tools,
//     monitoring scrapers, scripts. (The `berry-a8s-ops` CLI in this
//     package is the operator-facing front end over it.)
//
//   - `createMachineHand(client)` — wraps a registered machine as a Hand
//     so an agent can exec / invoke MCP tools on that host. Machine exec
//     is a genuine execution-layer capability (unlike cluster ops, which
//     moved to the berry-a8s-ops CLI + skill — see 新-2).
//
//   - `createRemoteTeammateRuntimeFactory(client)` — bridges
//     @berry-agent/team so a Team leader can spawn teammates as
//     first-class cluster agents living on (possibly different) workers
//     instead of in-process runtimes on the leader's worker.
//
//   - admin-agent defaults — the berry-admin system prompt + the seed
//     helper that writes its AGENTS.md and ops skills on first boot.

export { A8sOperatorClient } from './operator-client.js';
export type { A8sOperatorClientOptions } from './operator-client.js';
export { createMachineHand, buildMachineTools } from './machine-hand.js';
export type { MachineHandOptions } from './machine-hand.js';
export { createRemoteTeammateRuntimeFactory } from './remote-teammate.js';
export type { RemoteTeammateRuntimeFactoryOptions } from './remote-teammate.js';
export {
  DEFAULT_ADMIN_SYSTEM_PROMPT,
  INSTALL_WORKER_SKILL,
  A8S_OPS_SKILL,
  seedAdminAgentHome,
} from './admin-agent-defaults.js';
export {
  TEAM_SKILL,
  CLUSTER_SKILL,
  COLLABORATION_SKILLS,
  seedCollaborationSkill,
} from './collaboration-skills.js';
export { SKILL_CREATOR_SKILL } from './skill-authoring.js';
