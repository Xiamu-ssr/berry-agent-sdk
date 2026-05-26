/**
 * Team runtime — glues TeamStore (persistent state) to managed agent runtimes.
 *
 * Host wiring:
 *   1. Open a Team with a leader id and a project path.
 *   2. Mount team.leaderHand() onto the leader runtime.
 *   3. When leader calls `spawn_teammate`, Team asks the host factory for a
 *      first-class teammate runtime and mounts team.teammateHand() on it.
 *   4. Persist state in project/.berry/team.json on every mutation.
 *
 * This package does NOT own the host agent registry; it
 * only owns the *team relation* between agents. An agent can be a member of
 * at most one team at a time (enforced by the host).
 */
import { randomUUID } from 'node:crypto';
import type { Hand, ManagedAgentTurnResult, ToolRegistration } from '@berry-agent/core';
import { createToolRegistrationHand, ToolGroup } from '@berry-agent/core';
import { z, ZodError, type ZodIssue } from 'zod';
import type { TeamState, TeammateId, TeammateRecord, TeamMessage } from './types.js';
import { WORKLIST_STATUS_VALUES } from './types.js';
import { TeamStore } from './store.js';
import { WorklistStore, WorklistError, type WorklistActor } from './worklist.js';
import { zWorklistTaskStatus } from './schema.js';

const zNonBlankString = z.string().refine((value) => value.trim().length > 0, 'is required.');
const zWorklistToolInput = z.object({
  action: zNonBlankString,
  id: z.string().optional(),
  title: z.string().optional(),
  description: z.string().optional(),
  assignee: zNonBlankString.optional(),
  status: zWorklistTaskStatus.optional(),
  reason: z.string().optional(),
  tags: z.array(z.string()).optional(),
}).passthrough();
const zWorklistIdInput = zWorklistToolInput.extend({ id: zNonBlankString });
const zWorklistCreateInput = zWorklistToolInput.extend({ title: zNonBlankString });
type WorklistToolInput = z.infer<typeof zWorklistToolInput>;

export interface TeamAgentRuntime {
  hasHand(id: string): boolean;
  addHand(hand: Hand): void;
  send(prompt: string): Promise<ManagedAgentTurnResult>;
}

/** Internal mapping teammate id → live runtime facade (not persisted). */
type TeammateRuntimes = Map<TeammateId, TeamAgentRuntime>;

/**
 * Host-provided factory that turns a teammate spec into a first-class runtime.
 *
 * Moved out of Team in v1.2 (2026-04-22): teammates are now *regular* agents
 * registered in the host's agent registry (so they show up in the host UI,
 * have their own SDK session store, etc), not ephemeral sub-agents living only
 * in Team's memory. Team delegates to the host and just keeps the relationship
 * (who leads whom).
 *
 * Implementations MUST persist the teammate as a regular agent before
 * returning — a crash between this call and the subsequent team.json save
 * is tolerable (orphan agent row, fixable), but a crash that loses the
 * agent record entirely would break rehydration.
 */
export type TeammateRuntimeFactory = (spec: SpawnTeammateSpec) => Promise<TeamAgentRuntime>;

/** Host-facing callback when a teammate is removed from a team. */
export type TeammateDisbandCallback = (id: TeammateId) => Promise<void>;

export interface SpawnTeammateSpec {
  id: TeammateId;
  role: string;
  systemPrompt: string;
  /** Tier in the host's model tier system ('strong' | 'balanced' | 'fast' | custom). Preferred over raw model id. */
  tier?: string;
  /** Explicit model id override. Leave undefined to use leader's tier or leader's model. */
  model?: string;
  inheritTools?: boolean;
  /** Absolute project path (matches team.project). Host may use it for cwd. */
  project: string;
  /** Agent id of the leader — hosts stamp this onto the teammate record so teammates can find their team. */
  leaderId: string;
}

export interface CreateTeamOptions {
  /** Host-assigned id for the leader agent (shown in UI + messages). */
  leaderId: string;
  /** Absolute path to the project root. Must exist. */
  project: string;
  /** Display name for the team. */
  name?: string;
  /**
   * Host factory for creating teammates as first-class runtimes. If omitted,
   * spawn_teammate will fail; team never creates hidden runtimes by itself.
   */
  runtimeFactory?: TeammateRuntimeFactory;
  /**
   * Host callback invoked when a teammate is disbanded — the host should
   * delete the teammate's registry entry (and optionally
   * archive its session logs).
   */
  onDisband?: TeammateDisbandCallback;
  /**
   * Host-provided live runtime lookup. Team asks the host when it needs to
   * message a teammate.
   * If omitted, Team can only message teammates it spawned this session.
   */
  runtimeLookup?: (id: TeammateId) => TeamAgentRuntime | undefined;
  /**
   * Function that returns the valid tier names (e.g. ['strong', 'balanced',
   * 'fast']) for this host. Used to populate the `tier` enum on spawn_teammate
   * tool schema so the leader picks from a meaningful list.
   */
  availableTiers?: () => string[];
}

export class Team {
  readonly store: TeamStore;
  readonly worklist: WorklistStore;
  private _state: TeamState;
  private _teammateRuntimes: TeammateRuntimes = new Map();
  private _runtimeFactory?: TeammateRuntimeFactory;
  private _onDisband?: TeammateDisbandCallback;
  private _runtimeLookup?: (id: TeammateId) => TeamAgentRuntime | undefined;
  private _availableTiers?: () => string[];

  private constructor(
    state: TeamState,
    store: TeamStore,
    hooks: Pick<CreateTeamOptions, 'runtimeFactory' | 'onDisband' | 'runtimeLookup' | 'availableTiers'> = {},
  ) {
    this._state = state;
    this.store = store;
    this.worklist = new WorklistStore(state.project);
    this._runtimeFactory = hooks.runtimeFactory;
    this._onDisband = hooks.onDisband;
    this._runtimeLookup = hooks.runtimeLookup;
    this._availableTiers = hooks.availableTiers;
  }

  /**
   * Create a new team or load an existing one from the project.
   * If team.json exists under project/.berry/, its state is adopted and the
   * Live teammate runtimes are NOT rehydrated here — the host decides when to
   * instantiate them.
   */
  static async open(opts: CreateTeamOptions): Promise<Team> {
    const store = new TeamStore(opts.project);
    const existing = await store.load();
    const hooks = {
      runtimeFactory: opts.runtimeFactory,
      onDisband: opts.onDisband,
      runtimeLookup: opts.runtimeLookup,
      availableTiers: opts.availableTiers,
    };
    if (existing) {
      // Sanity: leader id drift would silently break messaging. Surface it.
      if (existing.leaderId !== opts.leaderId) {
        throw new Error(
          `Team in ${opts.project} is led by "${existing.leaderId}", not "${opts.leaderId}". ` +
          `A project hosts at most one team in v1; disband the existing team or pick the right leader.`,
        );
      }
      return new Team(existing, store, hooks);
    }
    const fresh: TeamState = {
      name: opts.name ?? 'team',
      project: opts.project,
      leaderId: opts.leaderId,
      teammates: [],
      createdAt: Date.now(),
    };
    await store.save(fresh);
    return new Team(fresh, store, hooks);
  }

  get state(): TeamState {
    return this._state;
  }

  get teammates(): readonly TeammateRecord[] {
    return this._state.teammates;
  }

  /** Live runtime facade for a teammate, or undefined if not spawned (e.g. after restart). */
  teammateRuntime(id: TeammateId): TeamAgentRuntime | undefined {
    return this._teammateRuntimes.get(id);
  }

  /**
   * Create a new teammate as a first-class host runtime.
   *
   * Delegates to the host's `runtimeFactory` (supplied at Team.open time) to
   * register the teammate in the host registry. Throws if no factory was
   * provided; team never creates hidden runtimes by itself.
   *
   * After the host returns a live runtime, Team mounts the teammate-side
   * tools (message_leader, worklist) and stores the record in team.json.
   */
  async spawnTeammate(input: {
    id: TeammateId;
    role: string;
    systemPrompt: string;
    tier?: string;
    model?: string;
    inheritTools?: boolean;
  }): Promise<TeammateRecord> {
    if (this._state.teammates.some((t) => t.id === input.id)) {
      throw new Error(`Teammate "${input.id}" already exists in this team.`);
    }
    if (!this._runtimeFactory) {
      throw new Error(
        'Team has no runtimeFactory; the host must supply one so teammates can be registered as first-class runtimes.',
      );
    }

    const teammateRuntime = await this._runtimeFactory({
      id: input.id,
      role: input.role,
      systemPrompt: input.systemPrompt,
      tier: input.tier,
      model: input.model,
      inheritTools: input.inheritTools !== false,
      project: this._state.project,
      leaderId: this._state.leaderId,
    });

    this.mountTeammateHand(teammateRuntime, input.id);

    const record: TeammateRecord = {
      id: input.id,
      role: input.role,
      systemPrompt: input.systemPrompt,
      tier: input.tier,
      model: input.model,
      createdAt: Date.now(),
    };
    this._state.teammates.push(record);
    this._teammateRuntimes.set(input.id, teammateRuntime);
    await this.store.save(this._state);
    return record;
  }

  /**
   * Rehydrate a teammate's live runtime from its persisted record.
   *
   * Used after a host restart: team.json survives (teammate roster +
   * systemPrompt + model), but live runtime objects don't — they live in
   * `_teammateRuntimes`, a plain in-memory Map. Call this for each entry in
   * `state.teammates` on startup to bring the live instances back.
   *
   * Idempotent: if the teammate is already live, this is a no-op and
   * returns the existing runtime. If the teammate record doesn't exist,
   * throws — caller should have iterated `state.teammates`.
   *
   * IMPORTANT: the teammate's session log (conversation history) is
   * loaded automatically by the SDK's SessionStore from disk, so the
   * rehydrated runtime picks up where it left off. Only runtime plumbing
   * (tools, guards, provider binding) gets rebuilt here.
   */
  rehydrateTeammate(id: TeammateId): TeamAgentRuntime {
    const existing = this._teammateRuntimes.get(id);
    if (existing) return existing;

    const record = this._state.teammates.find((t) => t.id === id);
    if (!record) {
      throw new Error(`Cannot rehydrate teammate "${id}": no record in team.json.`);
    }

    // Teammates are regular managed runtimes in the host registry. On a host
    // restart the host re-instantiates them via its normal runtime lifecycle,
    // then calls team.rehydrateAll() — we just look them up and mount the
    // teammate-side tools. If the host can't find the runtime, something
    // bigger is wrong (orphan record); surface rather than auto-heal.
    if (!this._runtimeLookup) {
      throw new Error(
        `Cannot rehydrate teammate "${id}": no runtimeLookup supplied. Host must pass one to Team.open.`,
      );
    }
    const teammateRuntime = this._runtimeLookup(id);
    if (!teammateRuntime) {
      throw new Error(
        `Cannot rehydrate teammate "${id}": host registry has no runtime with that id. ` +
        `This likely means the teammate config was deleted without disbanding the team first.`,
      );
    }
    this.mountTeammateHand(teammateRuntime, record.id);
    this._teammateRuntimes.set(record.id, teammateRuntime);
    return teammateRuntime;
  }

  /** Rehydrate every teammate in the roster. Returns ids that were revived. */
  rehydrateAll(): TeammateId[] {
    const revived: TeammateId[] = [];
    for (const record of this._state.teammates) {
      if (!this._teammateRuntimes.has(record.id)) {
        try {
          this.rehydrateTeammate(record.id);
          revived.push(record.id);
        } catch (err) {
          // Log but don't fail the whole rehydrate; the host can reconcile.
          console.warn(`[team] teammate rehydrate skipped for ${record.id}:`, err);
        }
      }
    }
    return revived;
  }

  /** Remove a teammate. Does NOT delete its session log (kept for audit). */
  async disbandTeammate(id: TeammateId): Promise<void> {
    const idx = this._state.teammates.findIndex((t) => t.id === id);
    if (idx < 0) throw new Error(`Teammate "${id}" not found.`);
    this._state.teammates.splice(idx, 1);
    this._teammateRuntimes.delete(id);
    await this.store.save(this._state);
    // Let the host know so it can delete the teammate's registry entry from its
    // registry. We save team.json first so a crash between save and callback
    // leaves an orphan agent (fixable) rather than a ghost team entry.
    if (this._onDisband) {
      try { await this._onDisband(id); } catch (err) {
        console.warn(`[team] onDisband callback failed for ${id}:`, err);
      }
    }
  }

  /**
   * Disband the whole team and delete team-owned project artifacts.
   * Teammate session logs are intentionally left to the host registry.
   */
  async disband(): Promise<void> {
    const ids = this._state.teammates.map((t) => t.id);
    for (const id of ids) {
      await this.disbandTeammate(id);
    }
    await Promise.all([
      this.store.deleteArtifacts(),
      this.worklist.deleteArtifact(),
    ]);
    this._state.teammates = [];
  }

  /**
   * Leader → Teammate messaging. Synchronous RPC in v1: sends `content` as
   * a user message to the teammate runtime, awaits its reply, returns the
   * reply text. Both the outbound message and the reply are logged.
   */
  async messageTeammate(teammateId: TeammateId, content: string): Promise<string> {
    // First check our local cache, then fall back to the host's registry.
    // This handles the cold-start case where the host has just revived the
    // teammate runtime but rehydrateTeammate hasn't been invoked yet.
    let runtime = this._teammateRuntimes.get(teammateId);
    if (!runtime && this._runtimeLookup) {
      runtime = this._runtimeLookup(teammateId);
      if (runtime) {
        // Opportunistically rehydrate so subsequent calls are fast and the
        // teammate tools are mounted.
        try { this.rehydrateTeammate(teammateId); } catch { /* ignore — we got a runtime anyway */ }
      }
    }
    if (!runtime) {
      throw new Error(
        `Teammate "${teammateId}" has no live runtime. ` +
        `The host must register it before the leader can message it.`,
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
    const turn = await runtime.send(content);
    await this.store.appendMessage({
      id: randomUUID(),
      ts: Date.now(),
      from: teammateId,
      to: '@leader',
      content: turn.result.text,
      replyTo: requestId,
    });
    return turn.result.text;
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

  private mountTeammateHand(runtime: TeamAgentRuntime, teammateId: TeammateId): void {
    const hand = this.teammateHand(teammateId);
    if (!runtime.hasHand(hand.id)) {
      runtime.addHand(hand);
    }
  }

  /** Read the full team message log (v1 — fine for small teams). */
  async readMessages(): Promise<TeamMessage[]> {
    return this.store.readMessages();
  }

  // ================ Tool factories ================

  /**
   * Leader-facing hand: creating / messaging / listing / disbanding teammates.
   * Mount this on the leader runtime.
   */
  leaderHand(): Hand {
    return createToolRegistrationHand({
      id: `team:${this._state.leaderId}:leader`,
      kind: 'team',
      displayName: `${this._state.name} leader`,
      tools: this.leaderTools(),
    });
  }

  /**
   * Teammate-facing hand: message the leader and coordinate through worklist.
   * Mount this on the teammate runtime.
   */
  teammateHand(ownId: TeammateId): Hand {
    return createToolRegistrationHand({
      id: `team:${this._state.leaderId}:teammate:${ownId}`,
      kind: 'team',
      displayName: `${this._state.name} teammate ${ownId}`,
      tools: this.teammateTools(ownId),
    });
  }

  /**
   * Leader-facing tools: creating / messaging / listing / disbanding teammates.
   * Prefer `leaderHand()` for mounting; this remains the low-level tool factory.
   */
  leaderTools(): ToolRegistration[] {
    return [
      this.spawnTeammateToolDefinition(),
      {
        definition: {
          name: 'message_teammate',
          group: ToolGroup.Team,
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
          group: ToolGroup.Team,
          description: 'List all current teammates and their roles.',
          inputSchema: { type: 'object', properties: {} },
        },
        execute: async () => {
          if (this._state.teammates.length === 0) {
            return { content: 'No teammates yet. Use spawn_teammate to recruit.' };
          }
          const lines = this._state.teammates.map((t) => {
            const modelInfo = t.tier ? ` [tier:${t.tier}]` : t.model ? ` (${t.model})` : '';
            return `- ${t.id} — ${t.role}${modelInfo}`;
          });
          return { content: `Team "${this._state.name}":\n${lines.join('\n')}` };
        },
      },
      {
        definition: {
          name: 'disband_teammate',
          group: ToolGroup.Team,
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
      this.worklistTool('@leader'),
      {
        definition: {
          name: 'read_team_inbox',
          group: ToolGroup.Team,
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
   * Build the spawn_teammate tool. Extracted so the tier enum can be
   * populated dynamically from the host's tier config at mount time.
   */
  private spawnTeammateToolDefinition(): ToolRegistration {
    const tiers = this._availableTiers?.() ?? [];
    const tierSchema = tiers.length > 0
      ? {
          type: 'string' as const,
          enum: tiers,
          description:
            `Model tier for the teammate. Tiers map to concrete models at the host; they're the ` +
            `preferred way to pick a model (stable across model swaps). Available: ${tiers.join(', ')}. ` +
            `Omit to inherit the leader's model.`,
        }
      : {
          type: 'string' as const,
          description:
            `Model tier for the teammate (host-defined). Omit to inherit the leader's model.`,
        };
    return {
      definition: {
        name: 'spawn_teammate',
        group: ToolGroup.Team,
        description:
          'Recruit a new teammate into your team. Creates a *first-class agent* in the host ' +
          'registry (visible in the Agents tab, with its own session log and working dir) and ' +
          'marks it as a teammate of yours. Only the leader can call this.\n\n' +
          'Pick a model tier (not a raw model id) so the choice stays stable when models are ' +
          "swapped. Use for long-running specialist roles (e.g. a code reviewer, a researcher, " +
          "a test runner) where persistent conversation history matters.",
        inputSchema: {
          type: 'object',
          properties: {
            id: {
              type: 'string',
              description: 'Unique id for this teammate, e.g. "reviewer", "researcher". Used in message routing and as the host agent id.',
            },
            role: {
              type: 'string',
              description: 'Short display name / role description for UI (e.g. "Security Reviewer").',
            },
            systemPrompt: {
              type: 'string',
              description: "System prompt defining the teammate's role and behavior.",
            },
            tier: tierSchema,
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
            tier: input.tier as string | undefined,
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
    };
  }

  /**
   * Teammate-facing tools: message_leader + worklist. Mounted automatically
   * when spawnTeammate creates a teammate runtime.
   */
  teammateTools(ownId: TeammateId): ToolRegistration[] {
    return [
      {
        definition: {
          name: 'message_leader',
          group: ToolGroup.Team,
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
      this.worklistTool(ownId),
    ];
  }

  /**
   * Worklist tool factory — one tool, many actions. Scoped to the caller's
   * identity (actor) so the state machine can enforce permissions. Leader
   * gets `@leader`, teammates get their own id.
   *
   * Why single-tool: token budget in the system prompt, and LLMs handle
   * multi-action tools well (cf. Anthropic's `bash` / `str_replace_editor`).
   */
  private worklistTool(actor: WorklistActor): ToolRegistration {
    const isLeader = actor === '@leader';
    const actions = isLeader
      ? 'list, view, create, update, delete, claim, start, complete, fail'
      : 'list, view, create, claim, start, complete, fail';
    return {
      definition: {
        name: 'worklist',
        group: ToolGroup.Team,
        description:
          `Shared team task board at <project>/.berry/worklist.json. Use this to coordinate ` +
          `work between team members. The state machine is enforced:\n` +
          `  unclaimed → claimed → in_progress → done | failed\n\n` +
          `Available actions (${actor}): ${actions}.\n\n` +
          (isLeader
            ? 'As leader you can also force any status via `update`, and delete tasks. '
              + 'Creating a task without `assignee` leaves it unclaimed for the team to pick up.'
            : 'Create captures your own follow-ups (self-assigned). '
              + 'Claim grabs an unclaimed task. Use start/complete/fail to drive your own tasks through the state machine.'),
        inputSchema: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: isLeader
                ? ['list', 'view', 'create', 'update', 'delete', 'claim', 'start', 'complete', 'fail']
                : ['list', 'view', 'create', 'claim', 'start', 'complete', 'fail'],
              description: 'Which worklist operation to perform.',
            },
            id: { type: 'string', description: 'Task id (required for view/update/delete/claim/start/complete/fail).' },
            title: { type: 'string', description: 'Task title (create/update).' },
            description: { type: 'string', description: 'Task description / body (create/update).' },
            assignee: {
              type: 'string',
              description: 'Teammate id or "@leader" to assign to (create/update).',
            },
            status: {
              type: 'string',
              enum: [...WORKLIST_STATUS_VALUES],
              description: 'Force a status (leader update only — bypasses state machine).',
            },
            reason: {
              type: 'string',
              description: 'Failure reason (required for fail).',
            },
            tags: {
              type: 'array',
              items: { type: 'string' },
              description: 'Tags/labels (create/update).',
            },
          },
          required: ['action'],
        },
      },
      execute: async (input) => {
        let action = 'unknown';
        try {
          const parsedInput = parseWorklistToolInput(input);
          action = parsedInput.action;
          switch (action) {
            case 'list': {
              const tasks = await this.worklist.list();
              if (tasks.length === 0) return { content: 'Worklist empty.' };
              return {
                content: tasks
                  .map((t) => `- ${t.id} [${t.status}] ${t.title}${t.assignee ? ` (@${t.assignee})` : ''}`)
                  .join('\n'),
              };
            }
            case 'view': {
              const { id } = parseWorklistActionInput(zWorklistIdInput, input);
              const task = await this.worklist.get(id);
              if (!task) return { content: `Task ${id} not found.`, isError: true };
              return { content: JSON.stringify(task, null, 2) };
            }
            case 'create': {
              const args = parseWorklistActionInput(zWorklistCreateInput, input);
              const task = await this.worklist.create(actor, {
                title: args.title,
                description: args.description,
                assignee: args.assignee,
                tags: args.tags,
              });
              return { content: `Created ${task.id}: ${task.title} [${task.status}]` };
            }
            case 'update': {
              const args = parseWorklistActionInput(zWorklistIdInput, input);
              const task = await this.worklist.update(actor, args.id, {
                title: args.title,
                description: args.description,
                assignee: args.assignee,
                status: args.status,
                tags: args.tags,
                failureReason: args.reason,
              });
              return { content: `Updated ${task.id} → [${task.status}]` };
            }
            case 'delete': {
              const { id } = parseWorklistActionInput(zWorklistIdInput, input);
              await this.worklist.remove(actor, id);
              return { content: `Deleted ${id}.` };
            }
            case 'claim': {
              const { id } = parseWorklistActionInput(zWorklistIdInput, input);
              const task = await this.worklist.claim(actor, id);
              return { content: `Claimed ${task.id}.` };
            }
            case 'start': {
              const { id } = parseWorklistActionInput(zWorklistIdInput, input);
              const task = await this.worklist.start(actor, id);
              return { content: `Started ${task.id} (now in_progress).` };
            }
            case 'complete': {
              const { id } = parseWorklistActionInput(zWorklistIdInput, input);
              const task = await this.worklist.complete(actor, id);
              return { content: `Completed ${task.id}.` };
            }
            case 'fail': {
              const args = parseWorklistActionInput(zWorklistIdInput, input);
              const task = await this.worklist.fail(
                actor,
                args.id,
                args.reason ?? '',
              );
              return { content: `Failed ${task.id}: ${task.failureReason}` };
            }
            default:
              return { content: `Unknown action: ${action}`, isError: true };
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return { content: `worklist ${action} failed: ${msg}`, isError: true };
        }
      },
    };
  }
}

function parseWorklistToolInput(input: unknown): WorklistToolInput {
  return parseWorklistActionInput(zWorklistToolInput, input);
}

function parseWorklistActionInput<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (parsed.success) return parsed.data;
  throw new WorklistError(formatWorklistInputError(parsed.error));
}

function formatWorklistInputError(error: ZodError): string {
  const issue = error.issues[0];
  return `${formatIssuePath(issue?.path ?? [])} ${formatIssueMessage(issue)}`;
}

function formatIssuePath(path: Array<string | number>): string {
  if (path.length === 0) return '`input`';
  const [first, ...rest] = path;
  return rest.reduce<string>((out, part) => (
    typeof part === 'number' ? `${out}[${part}]` : `${out}.${part}`
  ), `\`${String(first)}\``);
}

function formatIssueMessage(issue: ZodIssue | undefined): string {
  if (!issue) return 'is invalid.';
  if (issue.path[0] === 'status') return `must be one of: ${WORKLIST_STATUS_VALUES.join(', ')}.`;
  return issue.message;
}
