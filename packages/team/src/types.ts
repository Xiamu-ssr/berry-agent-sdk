/**
 * Team type model.
 *
 * A Team is a named group of Agents rooted at a Project directory, with one
 * Leader and zero or more Teammates. All inter-agent state (message log,
 * worklist) lives under `project/.berry/`.
 *
 * Topology in v1:
 *   - Manager-Worker tree, depth 1 (leader → teammates, no nesting).
 *   - Star messaging: teammates can only `message_leader`, leader broadcasts
 *     or directly `message_teammate(name, …)`.
 *   - Persistent teammates (survive across turns within a session).
 */

/** Unique identifier for a teammate within a team. Stable, used in message routing. */
export type TeammateId = string;

/** A member of the team. Metadata only — the actual Agent instance lives in TeamRuntime. */
export interface TeammateRecord {
  id: TeammateId;
  role: string;          // display name / short role description
  systemPrompt: string;  // baked-in role prompt
  model?: string;        // optional model override; inherits leader's provider otherwise
  createdAt: number;
}

/** Persisted team state. Lives at project/.berry/team.json (written by TeamStore). */
export interface TeamState {
  /** Display name for the team (UI). */
  name: string;
  /** Absolute path to the project root this team is scoped to. */
  project: string;
  /** Agent id of the leader. Exists in the host (berry-claw) agent registry. */
  leaderId: string;
  /** Registered teammates. */
  teammates: TeammateRecord[];
  /** Unix ms when the team was created. */
  createdAt: number;
}

/** An entry in the shared message log under project/.berry/messages.jsonl. */
export interface TeamMessage {
  id: string;         // ULID-like / nanoid; monotonic within a team
  ts: number;         // unix ms
  from: TeammateId | '@leader';
  to: TeammateId | '@leader' | '@broadcast';
  content: string;
  /** Correlates request / response pairs when leader directs a teammate. */
  replyTo?: string;
}
