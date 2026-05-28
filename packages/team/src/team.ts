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
import { createToolRegistrationHand } from '@berry-agent/core';
import type { TeamState, TeammateId, TeammateRecord, TeamMessage } from './types.js';
import { TeamStore } from './store.js';
import { WorklistStore } from './worklist.js';
import { buildLeaderTools, buildTeammateTools } from './tools.js';

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

  /** Tier names available to the host. Used by the spawn_teammate tool schema. */
  availableTiers(): string[] {
    return this._availableTiers?.() ?? [];
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
    return buildLeaderTools(this);
  }

  /**
   * Teammate-facing tools: message_leader + worklist. Mounted automatically
   * when spawnTeammate creates a teammate runtime.
   */
  teammateTools(ownId: TeammateId): ToolRegistration[] {
    return buildTeammateTools(this, ownId);
  }
}
