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

/**
 * Worklist task state. The state machine is enforced in WorklistStore on
 * every mutation — bad transitions throw instead of silently passing.
 *
 *   unclaimed → claimed → in_progress → done
 *                                       ↓
 *                                     failed
 *
 * Leaders can force any state (including re-opening a done/failed task) via
 * the `update` action. Teammates are bound by the state machine.
 */
export type WorklistTaskStatus = 'unclaimed' | 'claimed' | 'in_progress' | 'done' | 'failed';

export interface WorklistTask {
  id: string;              // short stable id, e.g. 'T-0001'
  title: string;
  description?: string;    // longer body; markdown allowed
  status: WorklistTaskStatus;
  assignee?: TeammateId | '@leader';  // who owns this task (empty = unclaimed)
  createdBy: TeammateId | '@leader';
  createdAt: number;
  updatedAt: number;
  /** Set when status=done. */
  completedAt?: number;
  /** Set when status=failed. */
  failureReason?: string;
  /** Optional free-form tags/labels for the UI. */
  tags?: string[];
}

/** Persisted worklist. Lives at project/.berry/worklist.json. */
export interface WorklistState {
  tasks: WorklistTask[];
  /** Monotonic counter for next task id (so ids don't collide after deletion). */
  nextId: number;
  updatedAt: number;
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
