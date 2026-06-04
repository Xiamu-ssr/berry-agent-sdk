// ============================================================
// Berry Agent SDK — Agent Core
// ============================================================
// The main Agent class. Pure library, no CLI dependency.
// Manages: agent loop, tools, sessions, compaction, cache.

import type {
  AgentConfig,
} from './agent-config-types.js';
import type {
  AgentStatus,
  QueryOptions,
  CreateSessionOptions,
  QueryResult,
  AgentEvent,
  DelegateConfig,
  DelegateResult,
  Middleware,
  MiddlewareContext,
} from './agent-runtime-types.js';
import type {
  ContentBlock,
  Message,
} from './content-types.js';
import {
  providerPublicConfig,
  type ProviderConfig,
  type ProviderPublicConfig,
} from './provider-types.js';
import type {
  ToolDefinition,
  ToolGuard,
  ToolRegistration,
} from './tool-types.js';
import type {
  Session,
  SessionStore,
  TodoItem,
} from './session-types.js';
import type {
  SystemPromptBlock,
  SystemPromptInput,
} from '@berry-agent/small-shared-core';
import { normalizeSystemPrompt } from '@berry-agent/small-shared-core';
import type { Hand, HandRegistry, HandToolAdapterOptions } from './hands.js';
import type { EventLogListener, EventLogStore, GetEventsOptions, SessionEvent, SessionEventDraft } from './event-log/types.js';
import type { AgentMemory, ProjectContext } from './workspace/types.js';
import type { MemoryProvider } from './memory/provider.js';
import { saveAgentConfigSync, type ReasoningEffort } from './workspace/initializer.js';
import type { CompactionResult } from './compaction/compactor.js';
import type { CompactionStrategy } from './compaction/types.js';
import type { Skill } from './skills/types.js';
import {
  installSkill,
  removeSkill,
  listInstalledSkillNames,
  type InstallSkillInput,
} from './skills/installer.js';
import type { AgentHome } from './agent-home.js';
import type { PromptPack } from './prompts.js';
import type { AgentSessionView } from './chat-types.js';
import {
  bootAgent,
  snapshotFrom,
  getToolsFrom,
  getSkillMetasFrom,
  getMCPFrom,
  SkillManager,
  runDelegate,
  SessionController,
  type AgentWorkspaceData,
  buildAgentSystemPrompt,
  resolveAgentTools,
  AgentRunState,
  AgentCompactionCoordinator,
  AgentProviderController,
  registerBuiltinAgentTools,
  registerHandCapabilities,
  registerMemoryProviderCapabilities,
  registerRuntimeToolCapability,
  disposeAgentRuntime,
  runAgentQueryLoop,
  runAgentTurn,
  type AgentSnapshot,
  type MCPSummary,
  unregisterHandCapabilities,
  unregisterToolCapability,
} from './agent-helpers/index.js';

export class Agent {
  private providerRuntime: AgentProviderController;
  private systemPrompt: SystemPromptBlock[];
  private tools: Map<string, ToolRegistration>;
  private hands: HandRegistry;
  private handToolNames = new Map<string, Set<string>>();
  private handAdapterOptions: HandToolAdapterOptions;
  /**
   * Skill bookkeeping — lazy loading and index rendering.
   * Agent delegates to this manager; skill-dir state lives on the manager,
   * not on the Agent directly.
   */
  private skills: SkillManager;
  private cwd: string;
  private sessionStore: SessionStore;
  private compactionConfig: AgentConfig['compaction'];
  private compactionStrategy?: CompactionStrategy;
  private onEvent?: (event: AgentEvent) => void;
  private toolGuard?: ToolGuard;
  private middleware: Middleware[];
  private eventLogStore?: EventLogStore;
  private promptPack: PromptPack;
  private _memory?: AgentMemory;
  private _memoryProvider?: MemoryProvider;
  private _memoryReady: Promise<void> = Promise.resolve();
  private _projectContext?: ProjectContext;
  private workspaceData: AgentWorkspaceData;
  /**
   * Structured directory layout — the single source of truth for every
   * on-disk path this Agent owns. Always set (AGENTS.md §agent.json).
   */
  private _home: AgentHome;

  /** Snapshot of this agent's on-disk layout. */
  get home(): AgentHome {
    return this._home;
  }
  private _lastSessionId?: string;

  /** The session id used by the most recent send(), or undefined if no turn has been made yet. */
  get lastSessionId(): string | undefined {
    return this._lastSessionId;
  }

  /** Update the cached last-session id. Used by the managed runtime to keep a single source of truth. */
  setLastSessionId(sessionId: string | undefined): void {
    this._lastSessionId = sessionId;
  }
  private runState: AgentRunState;
  private compactionCoordinator: AgentCompactionCoordinator;
  /** Session lifecycle helper (resolve / create / list / clear / compact).
   *  Owns its own per-process crash-detection dedup cache. */
  private sessions!: SessionController;

  // Hot-reload: instance-level tool DENY-list (persisted to agent.json).
  // Applied after per-query allowedTools filtering.
  private _toolDenylist: Set<string> = new Set();

  // Lifecycle hooks
  private _onQueryStart?: (session: Session, prompt: string | ContentBlock[]) => void | Promise<void>;
  private _onQueryEnd?: (session: Session, result: QueryResult) => void | Promise<void>;

  /** Update agent status and emit status_change event. */
  private setStatus(status: AgentStatus, detail?: string): void {
    this.runState.setStatus(status, detail);
  }

  /** Current runtime status. */
  get status(): AgentStatus {
    return this.runState.status;
  }

  /** Optional human-readable detail for the current status (e.g. active tool names). */
  get statusDetail(): string | undefined {
    return this.runState.statusDetail;
  }

  /**
   * Inject an immediate message into the currently-running query, to be seen
   * by the next LLM inference within the same turn.
   *
   *   - Use `send()` for queued / next-turn messages (normal user prompts).
   *   - Use `interject()` for right-now messages that should not wait for the
   *     current turn to finish (e.g. "stop" nudges, breaking news).
   *
   * Also wakes any in-progress sleep tool early.
   */
  interject(text: string): void {
    this.runState.interject(text);
  }

  /**
   * Force-abort the currently-running turn. This is intentionally not a
   * resumable "pause"; the current provider/tool loop is stopped, query_end is
   * persisted as an error, and the next send() starts a fresh turn.
   */
  pause(reason = 'paused by host'): boolean {
    return this.runState.pause(reason);
  }

  /** Create a SleepSignal bound to this agent (consumed by runtime tools). */
  private createSleepSignal(): import('./agent-helpers/runtime-tools.js').SleepSignal {
    return this.runState.createSleepSignal();
  }

  /**
   * Drain any pending interject messages into a list of Message objects the
   * loop can prepend to the next LLM call. Called inside _queryLoop.
   */
  private drainInterjects(): Message[] {
    return this.runState.drainInterjects();
  }

  constructor(config: AgentConfig) {
    const boot = bootAgent(config);
    this.runState = new AgentRunState((event) => this.onEvent?.(event));
    this.providerRuntime = new AgentProviderController({
      provider: boot.provider,
      providerConfig: boot.providerConfig,
      providerResolver: boot.providerResolver,
      modelResolver: boot.modelResolver,
      homeRoot: boot.home.root,
    });
    this.systemPrompt = boot.systemPrompt;
    this.tools = boot.tools;
    this.hands = boot.hands;
    this.handToolNames = boot.handToolNames;
    this.handAdapterOptions = boot.handAdapterOptions;
    this.skills = boot.skills;
    this.cwd = boot.cwd;
    this.sessionStore = boot.sessionStore;
    this.compactionConfig = boot.compactionConfig;
    this.compactionStrategy = boot.compactionStrategy;
    this.onEvent = boot.onEvent;
    this.toolGuard = boot.toolGuard;
    this.middleware = boot.middleware;
    this.eventLogStore = boot.eventLogStore;
    this.promptPack = boot.promptPack;
    this._memory = boot.memory;
    this._memoryProvider = boot.memoryProvider;
    this._memoryReady = boot.memoryReady;
    this._projectContext = boot.projectContext;
    this.workspaceData = boot.workspaceData;
    this._home = boot.home;
    this._onQueryStart = boot.onQueryStart;
    this._onQueryEnd = boot.onQueryEnd;
    this._toolDenylist = boot.toolDenylist;

    registerBuiltinAgentTools({
      tools: this.tools,
      hasSkillDirs: () => this.skills.hasSkillDirs(),
      loadSkill: (name) => this.getSkill(name),
      enableDelegate: config.enableDelegate !== false,
      delegate: (message, delegateConfig) => this.delegate(message, delegateConfig),
    });

    // Persistent sub-agent spawning lives in @berry-agent/team (leader-only
    // `spawn_teammate` tool). The core Agent has no spawn API — `delegate()`
    // is the only in-core way to fork a sub-turn.

    registerMemoryProviderCapabilities(this.capabilityRegistry(), this._memoryProvider, this.handAdapterOptions);

    for (const hand of config.hands ?? []) {
      this.addHand(hand);
    }

    this.compactionCoordinator = new AgentCompactionCoordinator({
      compactionConfig: () => this.compactionConfig,
      setCompactionConfig: (next) => { this.compactionConfig = next; },
      compactionStrategy: () => this.compactionStrategy,
      memory: () => this._memory,
      provider: () => this.providerRuntime.currentProvider,
      promptPack: () => this.promptPack,
      middleware: () => this.middleware,
      middlewareContext: (session) => this.getMiddlewareContext(session),
      setStatus: (status, detail) => this.setStatus(status, detail),
    });

    // Session controller — getters keep refs live so switchModel() /
    // setSystemPrompt() / capability changes all show up without re-wiring the bag.
    this.sessions = new SessionController({
      sessionStore: this.sessionStore,
      eventLogStore: this.eventLogStore,
      toolGuardEnabled: !!this.toolGuard,
      getProjectContext: () => this._projectContext,
      getMemory: () => this._memory,
      getCompactionConfig: () => this.compactionConfig,
      getCompactionStrategy: () => this.compactionStrategy,
      getProvider: () => this.providerRuntime.currentProvider,
      getProviderConfig: () => this.providerRuntime.currentConfig,
      getSystemPrompt: () => this.systemPrompt,
      getPromptPack: () => this.promptPack,
      getTools: () => this.tools,
      interject: (text) => this.interject(text),
      emit: (event, onEvent) => this.emit(event, onEvent),
      buildSystemPrompt: (base) => this.buildSystemPrompt(base),
    });
  }

  /**
   * Send a turn to the agent and get a response. The single entry point —
   * handles tool loop, compaction, cache, session persistence. `prompt`
   * accepts a plain string or a `ContentBlock[]` for multimodal turns.
   * When `eventLogStore` is configured, appends events for every action.
   * The provider context is always committed to and read back from
   * messages.json before each LLM inference; events.jsonl is audit/UI history.
   */
  async send(prompt: string | ContentBlock[], options?: QueryOptions): Promise<QueryResult> {
    return runAgentTurn(
      {
        runState: this.runState,
        memoryReady: this._memoryReady,
        eventLogStore: this.eventLogStore,
        resetProviderResolver: () => this.providerRuntime.resetResolverForSession(),
        resolveSession: (queryOptions) => this.resolveSession(queryOptions),
        emit: (event, onEvent) => this.emit(event, onEvent),
        onQueryStart: this._onQueryStart,
        onQueryEnd: this._onQueryEnd,
        runQueryLoop: (session, activePrompt, queryOptions, emit, appendEvent, makeBase, log) =>
          this._queryLoop(session, activePrompt, queryOptions, emit, appendEvent, makeBase, log),
      },
      prompt,
      options,
    );
  }

  /** Internal: delegate the managed turn to the SDK harness runner. */
  private async _queryLoop(
    session: Session,
    prompt: string | ContentBlock[],
    options: QueryOptions | undefined,
    emit: (event: AgentEvent) => void,
    appendEvent: (event: SessionEvent) => Promise<void>,
    makeBase: () => { id: string; timestamp: number; sessionId: string; turnId?: string },
    log: EventLogStore | undefined,
  ): Promise<QueryResult> {
    return runAgentQueryLoop(
      {
        getSystemPrompt: () => this.systemPrompt,
        getPromptPackVersion: () => this.promptPack.version,
        resolveAllowedTools: (allowed, activeSession) => this.resolveAllowedTools(allowed, activeSession),
        buildSystemPrompt: (base, override) => this.buildSystemPrompt(base, override),
        compactionCoordinator: this.compactionCoordinator,
        drainInterjects: () => this.drainInterjects(),
        persistAndReadProviderMessages: (activeSession) => this.persistAndReadProviderMessages(activeSession),
        getProviderConfig: () => this.providerRuntime.currentConfig,
        callProvider: (request, stream, emitEvent) => this.providerRuntime.call(request, stream, emitEvent),
        getMiddleware: () => this.middleware,
        getMiddlewareContext: (activeSession) => this.getMiddlewareContext(activeSession),
        toolGuard: this.toolGuard,
        cwd: this.cwd,
        saveSession: (activeSession) => this.sessionStore.save(activeSession),
        setStatus: (status, detail) => this.setStatus(status, detail),
        setLastSessionId: (sessionId) => { this._lastSessionId = sessionId; },
      },
      {
        session,
        prompt,
        options,
        emit,
        appendEvent,
        makeBase,
        log,
      },
    );
  }

  // ===== Public API =====

  /** Create and persist an empty session before the first query turn. */
  async createSession(options?: CreateSessionOptions): Promise<Session> {
    return this.sessions.createSession(options);
  }

  /** Get a session by ID. When event log is configured, rebuilds from log. */
  async getSession(id: string): Promise<Session | null> {
    return this.sessions.getSession(id);
  }

  /** List all session IDs. When event log is configured, lists from log. */
  async listSessions(): Promise<string[]> {
    return this.sessions.listSessions();
  }

  /**
   * Clear all messages and event log for a session, effectively resetting it
   * to a blank state while keeping the same session ID. This is what "clear
   * chat" should mean: the next query on this session starts fresh.
   */
  async clearSession(id: string): Promise<void> {
    return this.sessions.clearSession(id);
  }

  /** Delete a session's SDK-owned data (messages + event log). */
  async deleteSession(id: string): Promise<void> {
    return this.sessions.deleteSession(id);
  }

  /**
   * Hydrate a UI/session view from SDK-owned data. `events.jsonl` is used
   * when present so products can render full history without maintaining
   * their own message cache.
   */
  async getSessionView(id: string, options?: { agentId?: string; eventLimit?: number; fullHistory?: boolean }): Promise<AgentSessionView | null> {
    return this.sessions.getSessionView(id, options);
  }

  /** Append a host/runtime event into the SDK-owned session event log. */
  async appendSessionEvent(sessionId: string, draft: SessionEventDraft): Promise<SessionEvent | null> {
    return this.sessions.appendSessionEvent(sessionId, draft);
  }

  /**
   * Read raw events for a session. Returns the full append-only log
   * (or a filtered slice via GetEventsOptions). Empty array when the
   * session has no events yet, or when the event log store is not
   * configured. Products use this for pagination + audit views;
   * `getSessionView()` is the pre-hydrated UI shape.
   */
  async getSessionEvents(
    sessionId: string,
    options?: GetEventsOptions,
  ): Promise<SessionEvent[]> {
    if (!this.eventLogStore) return [];
    return this.eventLogStore.getEvents(sessionId, options);
  }

  /**
   * Subscribe to all session events appended to the SDK-owned event log.
   * Returns an unsubscribe function; no-op when no event log is wired.
   * Listeners must filter by sessionId themselves if they only care about
   * one session — this keeps the contract simple and matches the disk
   * layout (one file per session).
   */
  subscribeSessionEvents(listener: EventLogListener): () => void {
    if (!this.eventLogStore) return () => {};
    return this.eventLogStore.subscribe(listener);
  }

  /** List all sessions as hydrated SDK views, newest first. */
  async listSessionViews(options?: { agentId?: string; includeMessages?: boolean; eventLimit?: number }): Promise<AgentSessionView[]> {
    return this.sessions.listSessionViews(options);
  }

  /**
   * Register an additional in-process tool at runtime.
   *
   * Internally this is represented as a one-tool SDK hand so runtime tools do
   * not bypass the hand/capability boundary.
   */
  addTool(tool: ToolRegistration): void {
    this.assertNotDisposed('addTool');
    registerRuntimeToolCapability(this.capabilityRegistry(), tool, this.handAdapterOptions);
  }

  /** Register a hand and expose its capabilities as model-visible tools. */
  addHand(hand: Hand, options?: HandToolAdapterOptions): void {
    this.assertNotDisposed('addHand');
    registerHandCapabilities(this.capabilityRegistry(), hand, {
      ...this.handAdapterOptions,
      ...options,
    });
  }

  hasHand(id: string): boolean {
    return !!this.hands.get(id);
  }

  private capabilityRegistry() {
    return {
      tools: this.tools,
      hands: this.hands,
      handToolNames: this.handToolNames,
    };
  }

  /** Remove a previously registered hand and all tools derived from it. */
  async removeHand(id: string): Promise<boolean> {
    this.assertNotDisposed('removeHand');
    const hand = unregisterHandCapabilities(this.capabilityRegistry(), id);
    if (!hand) return false;
    try {
      await hand.dispose?.();
    } catch (err) {
      console.warn(`[agent] disposing hand ${id} threw:`, err);
    }
    return true;
  }

  /**
   * Switch the model used by this agent. Accepts a model-ref string that
   * follows the same conventions as the `provider` field at construction:
   *
   *   - `'tier:fast'`  / `'tier:strong'` / `'tier:balanced'`
   *   - `'model:claude-sonnet-4-20250514'`
   *   - Bare model id (e.g. `'claude-sonnet-4-20250514'`) — treated as `model:`.
   *
   * When a `modelResolver` was provided at construction, the ref is resolved
   * by the host product — this can set up failover, tier mapping, etc.
   * Without a resolver, the ref is
   * treated as a bare model id and only the `model` field of the current
   * ProviderConfig is swapped (same key, same base URL, same type).
   *
   * Always drops any attached resolver so the new config is the single source
   * of truth. Callers who need failover after a switch should pass a
   * `modelResolver` at construction so switchModel can re-wire one.
   */
  switchModel(modelRef: string): void {
    this.providerRuntime.switchModel(modelRef);
  }

  /**
   * Override the reasoning effort level on the current provider config.
   * Takes effect on the next LLM inference. Persisted to agent.json.
   */
  setReasoningEffort(effort: ReasoningEffort): void {
    this.providerRuntime.setReasoningEffort(effort);
  }

  /** Get current provider config (read-only) */
  get currentProvider(): Readonly<ProviderPublicConfig> {
    return providerPublicConfig(this.providerRuntime.snapshotConfig());
  }

  // ===== Hot reload API =====
  //
  // These mutators let a host product reconfigure a running
  // Agent without destroying the instance, so sessions/memory/pending
  // interjects survive. Changes take effect on the next LLM inference.

  /** Replace the user-facing system prompt blocks. */
  setSystemPrompt(blocks: SystemPromptInput): void {
    this.assertNotDisposed('setSystemPrompt');
    this.systemPrompt = normalizeSystemPrompt(blocks);
  }

  private async persistAndReadProviderMessages(session: Session): Promise<Message[]> {
    session.lastAccessedAt = Date.now();
    await this.sessionStore.save(session);
    const persisted = await this.sessionStore.load(session.id);
    if (!persisted) {
      throw new Error(`Session disappeared after save: ${session.id}`);
    }
    session.messages = persisted.messages;
    session.metadata = persisted.metadata;
    session.createdAt = persisted.createdAt;
    session.lastAccessedAt = persisted.lastAccessedAt;
    return persisted.messages;
  }

  /**
   * Set the instance-level tool DENY-list. Names in the list are stripped
   * from every query regardless of per-query `allowedTools`. Pass an empty
   * array (or no arg) to clear. Persisted to `agent.json` synchronously so
   * a restart keeps the same denylist.
   *
   * Runtime tools (todo/sleep) are NOT exempt — if a product denies them
   * here, they are denied.
   */
  setToolDenylist(names: string[] = []): void {
    this.assertNotDisposed('setToolDenylist');
    this._toolDenylist = new Set(names);
    saveAgentConfigSync(this._home.root, {
      toolDenylist: [...this._toolDenylist],
    });
  }

  /** Current instance-level tool deny-list (read-only). */
  getToolDenylist(): string[] {
    return [...this._toolDenylist];
  }

  // ===== Lifecycle =====
  //
  // Five observable states:
  //   idle      — waiting for input
  //   tool_use  — running a turn (LLM call, tool execution, compaction — all fold here)
  //   sleeping  — suspended by the sleep tool; interject() wakes
  //   paused    — last turn was force-aborted by the host; next send() may continue
  //   disposed  — terminal; every further call rejects
  //
  // pause() aborts the active turn; it does not resume mid-provider-call.
  // `send()` is the single turn entry point.
  // `delegate()` forks a sub-turn; the agent stays in tool_use throughout.

  /**
   * Terminal shutdown. Disposes all child agents, clears pending interjects,
   * and marks the instance unusable. After dispose():
   *   - send() / delegate() reject
   *   - addTool / removeTool / setSystemPrompt / setToolDenylist throw
   *   - introspection still works so the product can render a final view
   *
   * Idempotent — calling dispose() twice is a no-op.
   */
  dispose(): Promise<void> {
    this._lastSessionId = undefined;
    return disposeAgentRuntime({
      runState: this.runState,
      hands: this.hands,
      handToolNames: this.handToolNames,
      memoryProvider: this._memoryProvider,
      setStatus: (status, detail) => this.setStatus(status, detail),
    });
  }

  /** True once dispose() has completed. */
  get isDisposed(): boolean {
    return this.runState.isDisposed;
  }

  // ===== Introspection =====

  /** Get current system prompt blocks */
  getSystemPrompt(): readonly SystemPromptBlock[] {
    return normalizeSystemPrompt(this.systemPrompt);
  }

  /** Get all registered tool definitions */
  getTools(): ToolDefinition[] {
    return getToolsFrom(this.introspectionDeps());
  }

  /** Get loaded skill metadata (empty if skills not yet loaded) */
  getSkillMetas(): Array<{ name: string; description: string; dir: string }> {
    return getSkillMetasFrom(this.skills.loadedSnapshot);
  }

  /**
   * Get MCP servers currently visible to this Agent, grouped by upstream
   * server name. Derived from the registered tools Map — any tool whose
   * `source.kind === 'mcp'` is rolled up here. Tool names remain prefixed
   * (`mcp__<server>__<tool>`), matching what the LLM sees.
   */
  getMCP(): MCPSummary[] {
    return getMCPFrom(this.introspectionDeps());
  }

  /** Get current working directory */
  getCwd(): string {
    return this.cwd;
  }

  /**
   * Capture a frozen-in-time POJO of agent configuration + runtime state.
   * Safe to pass around, serialize, or diff. Replaces the old inspect() /
   * getSnapshot() pair.
   */
  snapshot(): AgentSnapshot {
    return snapshotFrom(this.introspectionDeps());
  }

  /** Assemble the dependency bag introspection helpers read from. */
  private introspectionDeps() {
    return {
      providerConfig: this.providerRuntime.currentConfig,
      systemPrompt: this.systemPrompt,
      tools: this.tools,
      hands: this.hands,
      loadedSkills: this.skills.loadedSnapshot,
      cwd: this.cwd,
      middleware: this.middleware,
      toolGuard: this.toolGuard,
      workspaceRoot: this._home.root,
      memory: this._memory,
      compactionConfig: this.compactionConfig,
      compactionStrategy: this.compactionStrategy,
      eventLogStore: this.eventLogStore,
      status: this.runState.status,
      statusDetail: this.runState.statusDetail,
    };
  }

  /** Remove a runtime-added tool and dispose its backing hand when needed. */
  async removeTool(name: string): Promise<boolean> {
    this.assertNotDisposed('removeTool');
    try {
      return await unregisterToolCapability(this.capabilityRegistry(), name);
    } catch (err) {
      console.warn(`[agent] disposing tool ${name} threw:`, err);
      return true;
    }
  }

  private assertNotDisposed(action: string): void {
    if (this.runState.isDisposed) {
      throw new Error(`Cannot ${action}: agent has been disposed`);
    }
  }

  // ===== Delegate (one-shot fork with cache sharing) =====

  /**
   * One-shot forked execution with cache sharing.
   * The delegate sees the main agent's system prompt + tools + conversation
   * history as a cache prefix, then executes its own tool loop independently.
   *
   * @param message - The prompt for the delegate
   * @param config - Optional configuration overrides
   * @returns Final text + usage from the delegate's execution
   */
  async delegate(message: string, config?: DelegateConfig): Promise<DelegateResult> {
    return runDelegate(
      {
        status: this.runState.status,
        lastSessionId: this._lastSessionId,
        sessionStore: this.sessionStore,
        providerConfig: this.providerRuntime.currentConfig,
        provider: this.providerRuntime.currentProvider,
        toolGuard: this.toolGuard,
        middleware: this.middleware,
        cwd: this.cwd,
        onEvent: this.onEvent,
        systemPrompt: this.systemPrompt,
        setStatus: (status, detail) => this.setStatus(status, detail),
        buildSystemPrompt: (base, override) => this.buildSystemPrompt(base, override),
        resolveAllowedTools: (allowed, session) => this.resolveAllowedTools(allowed, session),
      },
      message,
      config,
    );
  }

  /** Agent memory (available when workspace is configured). */
  get memory(): AgentMemory | undefined {
    return this._memory;
  }

  /** Read the SDK-owned personal memory file. */
  async readMemory(): Promise<{ path: string; content: string }> {
    return this.workspaceData.readMemory();
  }

  /** Replace the SDK-owned personal memory file. */
  async writeMemory(content: string): Promise<{ path: string; bytes: number }> {
    return this.workspaceData.writeMemory(content);
  }

  /** Read the SDK-owned workspace instruction snippet (`AGENTS.md`). */
  async readInstructions(): Promise<{ path: string; content: string }> {
    return this.workspaceData.readInstructions();
  }

  /** Replace the SDK-owned workspace instruction snippet (`AGENTS.md`). */
  async writeInstructions(content: string): Promise<{ path: string; bytes: number }> {
    return this.workspaceData.writeInstructions(content);
  }

  /** Project context (available when project is configured). */
  get projectContext(): ProjectContext | undefined {
    return this._projectContext;
  }

  /** Read shared project knowledge visible to this agent. */
  async readProjectKnowledge(): Promise<{ project: string | null; files: Array<{ path: string; content: string }> }> {
    return this.workspaceData.readProjectKnowledge();
  }

  /** Replace shared project knowledge for this agent's project binding. */
  async writeProjectKnowledge(content: string): Promise<{ project: string; path: string; bytes: number }> {
    return this.workspaceData.writeProjectKnowledge(content);
  }

  // ===== Internal Methods =====

  private getMiddlewareContext(session: Session): MiddlewareContext {
    return {
      sessionId: session.id,
      model: this.providerRuntime.currentConfig.model,
      provider: this.providerRuntime.currentConfig.type,
      cwd: this.cwd,
    };
  }

  private async resolveSession(options?: QueryOptions): Promise<Session> {
    return this.sessions.resolveSession(options);
  }

  private resolveAllowedTools(allowed?: string[], session?: Session): ToolRegistration[] {
    return resolveAgentTools(
      {
        registeredTools: () => this.tools.values(),
        toolDenylist: () => this._toolDenylist,
        createSleepSignal: () => this.createSleepSignal(),
        emit: (event) => this.emit(event),
      },
      allowed,
      session,
    );
  }

  /**
   * Get the current todo list for a session. Returns an empty array if
   * no todos have been set yet.
   */
  async getTodos(sessionId: string): Promise<TodoItem[]> {
    return this.sessions.getTodos(sessionId);
  }

  /**
   * Manually compact a session's message history.
   *
   * Hosts that enforce "1 agent 1 session" use this as the equivalent of
   * OpenClaw's `/new` — it collapses old messages into a summary, keeping
   * the session alive with a smaller context window. Does NOT create a
   * new session.
   */
  async compactSession(sessionId: string, options?: { reason?: string }): Promise<CompactionResult> {
    return this.sessions.compactSession(sessionId, options);
  }

  private async buildSystemPrompt(
    basePrompt: readonly SystemPromptBlock[],
    override?: SystemPromptInput,
  ): Promise<SystemPromptBlock[]> {
    return buildAgentSystemPrompt(
      {
        projectContext: () => this._projectContext,
        agentMdPath: this._home.agentMdPath,
        renderSkillIndexBlock: () => this.skills.renderIndexBlock(),
      },
      basePrompt,
      override,
    );
  }

  /** Get a loaded skill by name (for lazy content loading). */
  async getSkill(name: string): Promise<Skill | null> {
    return this.skills.getSkill(name);
  }

  /** Get all loaded skill indexes. */
  async getSkillIndexes(): Promise<Array<{ name: string; description: string; whenToUse?: string }>> {
    return this.skills.getSkillIndexes();
  }

  /**
   * Install a skill into this agent's home skills dir, then invalidate the
   * skill cache so the next turn's system-prompt index includes it. The
   * content (SKILL.md + optional files) comes from the caller — the SDK does
   * not source skills; products / a8s decide what to install.
   */
  async installSkill(input: InstallSkillInput): Promise<void> {
    this.assertNotDisposed('installSkill');
    await installSkill(this._home.skillsDir, input);
    this.skills.reload();
    // Re-warm the cache so synchronous readers (snapshot's skill index) see
    // the change immediately, not only on the next turn's prompt build.
    await this.skills.getLoadedSkills();
  }

  /** Remove a skill from this agent's home; reload the cache. Returns whether it existed. */
  async removeSkill(name: string): Promise<boolean> {
    this.assertNotDisposed('removeSkill');
    const removed = await removeSkill(this._home.skillsDir, name);
    if (removed) {
      this.skills.reload();
      await this.skills.getLoadedSkills();
    }
    return removed;
  }

  /** Names of skills currently installed in this agent's home skills dir. */
  async listInstalledSkills(): Promise<string[]> {
    return listInstalledSkillNames(this._home.skillsDir);
  }

  private emit(event: AgentEvent, queryOnEvent?: (event: AgentEvent) => void): void {
    this.onEvent?.(event);
    queryOnEvent?.(event);
  }
}
