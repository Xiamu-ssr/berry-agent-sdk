/**
 * Team runtime — glues TeamStore (persistent state) to live Agent instances.
 *
 * Host wiring (berry-claw):
 *   1. Instantiate a Team with the leader's Agent and a project path.
 *   2. Mount team.leaderTools() onto the leader Agent.
 *   3. When leader calls `spawn_teammate`, Team creates a child Agent via
 *      `leader.spawn()` and mounts team.teammateTools() on it.
 *   4. Persist state in project/.berry/team.json on every mutation.
 *
 * This package does NOT own the host agent registry (berry-claw does); it
 * only owns the *team relation* between agents. An agent can be a member of
 * at most one team at a time (enforced by the host).
 */
import { randomUUID } from 'node:crypto';
import type { Agent, ToolRegistration } from '@berry-agent/core';
import type { TeamState, TeammateId, TeammateRecord, TeamMessage } from './types.js';
import { TeamStore } from './store.js';

/** Internal mapping teammate id → live Agent instance (not persisted). */
type TeammateAgents = Map<TeammateId, Agent>;

export interface CreateTeamOptions {
  /** Host-assigned id for the leader agent (shown in UI + messages). */
  leaderId: string;
  /** Leader Agent instance — the one we'll spawn teammates off. */
  leader: Agent;
  /** Absolute path to the project root. Must exist. */
  project: string;
  /** Display name for the team. */
  name?: string;
}

export class Team {
  readonly store: TeamStore;
  private _state: TeamState;
  private _leader: Agent;
  private _teammateAgents: TeammateAgents = new Map();

  private constructor(state: TeamState, leader: Agent, store: TeamStore) {
    this._state = state;
    this._leader = leader;
    this.store = store;
  }

  /**
   * Create a new team or load an existing one from the project.
   * If team.json exists under project/.berry/, its state is adopted and the
   * provided leader is assumed to correspond to leaderId. Live teammate
   * Agents are NOT rehydrated here — the host decides when to re-spawn them.
   */
  static async open(opts: CreateTeamOptions): Promise<Team> {
    const store = new TeamStore(opts.project);
    const existing = await store.load();
    if (existing) {
      // Sanity: leader id drift would silently break messaging. Surface it.
      if (existing.leaderId !== opts.leaderId) {
        throw new Error(
          `Team in ${opts.project} is led by "${existing.leaderId}", not "${opts.leaderId}". ` +
          `A project hosts at most one team in v1; disband the existing team or pick the right leader.`,
        );
      }
      return new Team(existing, opts.leader, store);
    }
    const fresh: TeamState = {
      name: opts.name ?? 'team',
      project: opts.project,
      leaderId: opts.leaderId,
      teammates: [],
      createdAt: Date.now(),
    };
    await store.save(fresh);
    return new Team(fresh, opts.leader, store);
  }

  get state(): TeamState {
    return this._state;
  }

  get teammates(): readonly TeammateRecord[] {
    return this._state.teammates;
  }

  /** Live Agent instance for a teammate, or undefined if not spawned (e.g. after restart). */
  teammateAgent(id: TeammateId): Agent | undefined {
    return this._teammateAgents.get(id);
  }

  /**
   * Create a new teammate — spawns a child Agent off the leader and registers
   * it in team state. Throws if id is already taken.
   */
  async spawnTeammate(input: {
    id: TeammateId;
    role: string;
    systemPrompt: string;
    model?: string;
    inheritTools?: boolean;
  }): Promise<TeammateRecord> {
    if (this._state.teammates.some((t) => t.id === input.id)) {
      throw new Error(`Teammate "${input.id}" already exists in this team.`);
    }

    const childAgent = this._leader.spawn({
      id: input.id,
      systemPrompt: input.systemPrompt,
      model: input.model,
      inheritTools: input.inheritTools !== false,
    });

    // Mount the teammate-side tools so the child can call message_leader.
    for (const tool of this.teammateTools(input.id)) {
      childAgent.addTool(tool);
    }

    const record: TeammateRecord = {
      id: input.id,
      role: input.role,
      systemPrompt: input.systemPrompt,
      model: input.model,
      createdAt: Date.now(),
    };
    this._state.teammates.push(record);
    this._teammateAgents.set(input.id, childAgent);
    await this.store.save(this._state);
    return record;
  }

  /** Remove a teammate. Does NOT delete its session log (kept for audit). */
  async disbandTeammate(id: TeammateId): Promise<void> {
    const idx = this._state.teammates.findIndex((t) => t.id === id);
    if (idx < 0) throw new Error(`Teammate "${id}" not found.`);
    this._state.teammates.splice(idx, 1);
    this._teammateAgents.delete(id);
    await this.store.save(this._state);
  }

  /**
   * Leader → Teammate messaging. Synchronous RPC in v1: sends `content` as
   * a user message to the teammate's Agent, awaits its reply, returns the
   * reply text. Both the outbound message and the reply are logged.
   */
  async messageTeammate(teammateId: TeammateId, content: string): Promise<string> {
    const agent = this._teammateAgents.get(teammateId);
    if (!agent) {
      throw new Error(
        `Teammate "${teammateId}" has no live Agent instance. ` +
        `Teammates must be respawned after a restart (host responsibility).`,
      );
    }
    const requestId = randomUUID();
    await this.store.appendMessage({
      id: requestId,
      ts: Date.now(),
      from: '@leader',
      to: teammateId,
      content,
    });
    const result = await agent.query(content);
    await this.store.appendMessage({
      id: randomUUID(),
      ts: Date.now(),
      from: teammateId,
      to: '@leader',
      content: result.text,
      replyTo: requestId,
    });
    return result.text;
  }

  /**
   * Teammate → Leader messaging. Append-only: just log the message. The
   * leader picks it up when it reads its inbox (via `read_team_inbox` tool)
   * or via an event subscription from the host. Non-blocking by design so
   * teammates aren't stuck waiting for the leader to finish its turn.
   */
  async messageLeader(from: TeammateId, content: string): Promise<void> {
    await this.store.appendMessage({
      id: randomUUID(),
      ts: Date.now(),
      from,
      to: '@leader',
      content,
    });
  }

  /** Read the full team message log (v1 — fine for small teams). */
  async readMessages(): Promise<TeamMessage[]> {
    return this.store.readMessages();
  }

  // ================ Tool factories ================

  /**
   * Leader-facing tools: creating / messaging / listing / disbanding teammates.
   * Mount these on the leader Agent (via `agent.addTool()`).
   */
  leaderTools(): ToolRegistration[] {
    return [
      {
        definition: {
          name: 'spawn_teammate',
          description:
            'Recruit a new teammate into your team. Creates a persistent sub-agent with its own ' +
            'role and conversation history. Only the leader can call this. After spawning, use ' +
            '`message_teammate` to delegate work. Use for long-running specialist roles ' +
            '(e.g., a code reviewer, a researcher, a test runner).',
          inputSchema: {
            type: 'object',
            properties: {
              id: {
                type: 'string',
                description: 'Unique id for this teammate, e.g. "reviewer", "researcher". Used in message routing.',
              },
              role: {
                type: 'string',
                description: 'Short display name / role description for UI (e.g. "Security Reviewer").',
              },
              systemPrompt: {
                type: 'string',
                description: "System prompt defining the teammate's role and behavior.",
              },
              model: {
                type: 'string',
                description: 'Optional model override (e.g. "claude-opus-4.7"). Inherits leader provider otherwise.',
              },
              inheritTools: {
                type: 'boolean',
                description: 'Whether to inherit leader tools (default: true).',
              },
            },
            required: ['id', 'role', 'systemPrompt'],
          },
        },
        execute: async (input) => {
          try {
            const rec = await this.spawnTeammate({
              id: input.id as string,
              role: input.role as string,
              systemPrompt: input.systemPrompt as string,
              model: input.model as string | undefined,
              inheritTools: input.inheritTools as boolean | undefined,
            });
            return {
              content: `Teammate "${rec.id}" (${rec.role}) is ready. Use message_teammate to delegate.`,
              forUser: `[Team] Spawned teammate "${rec.id}" — ${rec.role}`,
            };
          } catch (err) {
            return {
              content: `spawn_teammate failed: ${err instanceof Error ? err.message : String(err)}`,
              isError: true,
            };
          }
        },
      },
      {
        definition: {
          name: 'message_teammate',
          description:
            'Send a message to one of your teammates and wait for their reply. ' +
            "This is how you delegate work or ask questions. Returns the teammate's full response.",
          inputSchema: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Teammate id, as used in spawn_teammate.' },
              content: { type: 'string', description: 'Your message to the teammate.' },
            },
            required: ['id', 'content'],
          },
        },
        execute: async (input) => {
          try {
            const reply = await this.messageTeammate(input.id as string, input.content as string);
            return {
              content: reply,
              forUser: `[Team] ${input.id} replied (${reply.length} chars)`,
            };
          } catch (err) {
            return {
              content: `message_teammate failed: ${err instanceof Error ? err.message : String(err)}`,
              isError: true,
            };
          }
        },
      },
      {
        definition: {
          name: 'list_team',
          description: 'List all current teammates and their roles.',
          inputSchema: { type: 'object', properties: {} },
        },
        execute: async () => {
          if (this._state.teammates.length === 0) {
            return { content: 'No teammates yet. Use spawn_teammate to recruit.' };
          }
          const lines = this._state.teammates.map(
            (t) => `- ${t.id} — ${t.role}${t.model ? ` (${t.model})` : ''}`,
          );
          return { content: `Team "${this._state.name}":\n${lines.join('\n')}` };
        },
      },
      {
        definition: {
          name: 'disband_teammate',
          description:
            'Remove a teammate from the team. Its session log is preserved for audit. ' +
            'Only use when the teammate role is no longer needed.',
          inputSchema: {
            type: 'object',
            properties: { id: { type: 'string', description: 'Teammate id to remove.' } },
            required: ['id'],
          },
        },
        execute: async (input) => {
          try {
            await this.disbandTeammate(input.id as string);
            return { content: `Teammate "${input.id}" disbanded.` };
          } catch (err) {
            return {
              content: `disband_teammate failed: ${err instanceof Error ? err.message : String(err)}`,
              isError: true,
            };
          }
        },
      },
      {
        definition: {
          name: 'read_team_inbox',
          description:
            'Read messages teammates have sent to you (leader). Returns messages in chronological order. ' +
            'Useful when a teammate reports progress or asks a question via message_leader.',
          inputSchema: {
            type: 'object',
            properties: {
              limit: {
                type: 'number',
                description: 'Maximum number of most-recent messages to return (default 20).',
              },
            },
          },
        },
        execute: async (input) => {
          const limit = (input.limit as number | undefined) ?? 20;
          const all = await this.readMessages();
          const inbox = all.filter((m) => m.to === '@leader' && m.from !== '@leader');
          const recent = inbox.slice(-limit);
          if (recent.length === 0) return { content: 'Inbox empty.' };
          return {
            content: recent
              .map((m) => `[${new Date(m.ts).toISOString()}] ${m.from}: ${m.content}`)
              .join('\n'),
          };
        },
      },
    ];
  }

  /**
   * Teammate-facing tools: just message_leader in v1. Mounted automatically
   * when spawnTeammate creates a child Agent.
   */
  teammateTools(ownId: TeammateId): ToolRegistration[] {
    return [
      {
        definition: {
          name: 'message_leader',
          description:
            'Send a message to your team leader. Use to report progress, ask for clarification, ' +
            'or request additional resources. Non-blocking — leader reads via read_team_inbox.',
          inputSchema: {
            type: 'object',
            properties: { content: { type: 'string', description: 'Your message to the leader.' } },
            required: ['content'],
          },
        },
        execute: async (input) => {
          try {
            await this.messageLeader(ownId, input.content as string);
            return { content: 'Message sent to leader.' };
          } catch (err) {
            return {
              content: `message_leader failed: ${err instanceof Error ? err.message : String(err)}`,
              isError: true,
            };
          }
        },
      },
    ];
  }
}
