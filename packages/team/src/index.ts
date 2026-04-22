/**
 * @berry-agent/team
 *
 * Team mode for Berry Agent SDK. Provides Leader/Teammate topology on top
 * of @berry-agent/core's `agent.spawn()` primitive, plus project-scoped
 * persistence (team state + message log under `<project>/.berry/`).
 *
 * Quick start:
 *   const team = await Team.open({
 *     leaderId: 'orange',
 *     leader: leaderAgent,
 *     project: '/path/to/project',
 *   });
 *   for (const t of team.leaderTools()) leaderAgent.addTool(t);
 *   // leader can now call spawn_teammate / message_teammate / etc.
 */
export { Team } from './team.js';
export type { CreateTeamOptions } from './team.js';
export { TeamStore } from './store.js';
export type {
  TeammateId,
  TeammateRecord,
  TeamState,
  TeamMessage,
} from './types.js';
