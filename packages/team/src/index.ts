/**
 * @berry-agent/team
 *
 * Team mode for Berry Agent SDK. Provides leader/teammate topology on top
 * of host-supplied managed runtimes, plus project-scoped persistence
 * (team state + message log under `<project>/.berry/`).
 *
 * Quick start:
 *   const team = await Team.open({
 *     leaderId: 'orange',
 *     project: '/path/to/project',
 *   });
 *   leaderRuntime.addHand(team.leaderHand());
 *   // leader can now call spawn_teammate / message_teammate / etc.
 */
export { Team } from './team.js';
export type { CreateTeamOptions, SpawnTeammateSpec, TeamAgentRuntime, TeammateRuntimeFactory } from './team.js';
export { TeamStore, readTeamLeaderId } from './store.js';
export { WorklistStore, WorklistError } from './worklist.js';
export type { WorklistActor } from './worklist.js';
export type {
  TeammateId,
  TeammateRecord,
  TeamState,
  TeamMessage,
  WorklistTask,
  WorklistTaskStatus,
  WorklistState,
} from './types.js';
export { WORKLIST_STATUS, WORKLIST_STATUS_VALUES } from './types.js';
export {
  zTeamMessage,
  zTeamState,
  zTeammateRecord,
  zWorklistState,
  zWorklistTask,
  zWorklistTaskStatus,
} from './schema.js';
