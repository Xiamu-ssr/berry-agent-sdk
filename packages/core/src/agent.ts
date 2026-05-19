// ============================================================
// Berry Agent SDK — Agent Core
// ============================================================
// The main Agent class. Pure library, no CLI dependency.
// Manages: agent loop, tools, sessions, compaction, cache.

import { createHash } from 'node:crypto';

import type {
  AgentConfig,
  AgentCreateConfig,
  AgentStatus,
  QueryOptions,
  CreateSessionOptions,
  QueryResult,
  Message,
  Provider,
  ProviderConfig,
  ProviderResolver,
  ProviderInput,
  ProviderRequest,
  ToolRegistration,
  Session,
  SessionMetadata,
  SessionStore,
  ContentBlock,
  ToolUseContent,
  ToolResultContent,
  TokenUsage,
  AgentEvent,
  ToolGuard,
  DelegateConfig,
  DelegateResult,
  Middleware,
  MiddlewareContext,
  ToolDefinition,
  TodoItem,
  SystemPromptBlock,
  SystemPromptInput,
  ModelRefResolver,
} from './types.js';
import { normalizeSystemPrompt, toProviderResolver, ToolGroup, SystemPromptCacheMode } from './types.js';
import type { EventLogStore, SessionEvent } from './event-log/types.js';
import { FileEventLogStore } from './event-log/jsonl-store.js';
import { AnthropicProvider } from './providers/anthropic.js';
import { OpenAIProvider } from './providers/openai.js';
import type { AgentMemory, ProjectContext } from './workspace/types.js';
import type { MemoryProvider } from './memory/provider.js';
import { FileAgentMemory } from './workspace/file-memory.js';
import { FileProjectContext } from './workspace/file-project.js';
import { initWorkspaceSync, saveAgentConfigSync, type ReasoningEffort } from './workspace/initializer.js';
import { estimateTokens, type CompactionResult, type ForkContext } from './compaction/compactor.js';
import type { CompactionStrategy } from './compaction/types.js';
import { DefaultCompactionStrategy } from './compaction/compactor.js';
import type { Skill } from './skills/types.js';
import { FileSessionStore } from './session/file-store.js';
import type { ProviderRegistry } from './registry.js';
import { AgentHome } from './agent-home.js';
import { resolvePromptPack, type PromptPack } from './prompts.js';
import {
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_SOFT_LAYERS,
  DEFAULT_MAX_TURNS,
  MAX_PTL_RETRIES,
  COMPACTION_TRIGGER_REASON,
} from './constants.js';
import { TOOL_LOAD_SKILL, TOOL_DELEGATE } from './tool-names.js';
import { executeTools } from './tool-executor.js';
import {
  shouldSoftCompact,
  shouldHardCompact,
  runCompaction,
  preCompactMemoryFlush,
} from './compaction-runner.js';
import { createRuntimeTools } from './runtime-tools.js';
import { isRetryableError } from './utils/retry.js';
import {
  generateId,
  generateEventId,
  generateTurnId,
  sleep,
  createProvider,
  isProviderResolver,
  providerConfigsEqual,
  isPromptTooLongError,
  extractContextWindowFromError,
  createInMemoryStore,
  createEmptySessionMetadata,
  extractText,
  accumulateUsage,
  mergeToolsByName,
  repairOrphanToolUses,
  snapshotFrom,
  getToolsFrom,
  getSkillMetasFrom,
  getMCPFrom,
  SkillManager,
  runDelegate,
  SessionController,
  callProvider,
  type AgentSnapshot,
  type MCPSummary,
} from './agent-helpers/index.js';

/** Internal config extension for sub-agent creation (not part of public API). */
interface InternalAgentConfig extends AgentConfig {
  _isSubAgent?: boolean;
  /**
   * Test-only / internal-hydration escape hatch for the base system prompt.
   * Kept here so internal/test code can bypass the normal public
   * `systemPrompt` entrypoint without touching on-disk workspace context.
   */
  _systemPromptOverride?: SystemPromptInput;
}

function shortHash(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return createHash('sha256').update(text ?? '').digest('hex').slice(0, 16);
}

export class Agent {
  private provider: Provider;
  private providerConfig: ProviderConfig;
  /**
   * Optional resolver. When set, the agent calls resolve() before each
   * provider request, rebuilding `this.provider` when the config changes,
   * and calls reportError() on failure.
   *
   * When `null`, the agent uses the static `providerConfig` / `provider`.
   */
  private providerResolver: ProviderResolver | null;
  /**
   * Product-supplied model-ref resolver. Core persists model refs as strings,
   * while host products decide how tier/model/raw refs map to
   * ProviderInput.
   */
  private _modelResolver: ModelRefResolver | null;
  private systemPrompt: SystemPromptBlock[];
  private tools: Map<string, ToolRegistration>;
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
  private _projectContext?: ProjectContext;
  /**
   * Structured directory layout — the single source of truth for every
   * on-disk path this Agent owns. Always set (AGENTS.md §agent.json).
   */
  private _home: AgentHome;

  /** Snapshot of this agent's on-disk layout. */
  get home(): AgentHome {
    return this._home;
  }
  private _children = new Map<string, Agent>();
  private _isSubAgent = false;
  private _lastSessionId?: string;

  /** The session id used by the most recent send(), or undefined if no turn has been made yet. */
  get lastSessionId(): string | undefined {
    return this._lastSessionId;
  }
  private _querying = false;
  private _status: import('./types.js').AgentStatus = 'idle';
  private _statusDetail?: string;
  // Interject mechanism — see interject() + sleep tool wiring
  private _pendingInterjects: string[] = [];
  private _interjectWakers: Array<() => void> = [];
  private _sleepDepth = 0;
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
  private setStatus(status: import('./types.js').AgentStatus, detail?: string): void {
    if (this._status === status && this._statusDetail === detail) return;
    this._status = status;
    this._statusDetail = detail;
    this.onEvent?.({ type: 'status_change', status, detail });
  }

  /** Current runtime status. */
  get status(): import('./types.js').AgentStatus {
    return this._status;
  }

  /** Optional human-readable detail for the current status (e.g. active tool names). */
  get statusDetail(): string | undefined {
    return this._statusDetail;
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
    if (!text || !text.trim()) return;
    this._pendingInterjects.push(text);
    // Wake any pending sleep waiters
    const wakers = this._interjectWakers.splice(0);
    for (const w of wakers) {
      try { w(); } catch { /* ignore */ }
    }
  }

  /** Create a SleepSignal bound to this agent (consumed by runtime-tools). */
  private createSleepSignal(): import('./runtime-tools.js').SleepSignal {
    return {
      onEnter: () => {
        this._sleepDepth++;
        this.setStatus('sleeping');
      },
      onExit: () => {
        this._sleepDepth = Math.max(0, this._sleepDepth - 1);
        if (this._sleepDepth === 0 && this._status === 'sleeping') {
          // Return to tool_use; the outer loop will reset status after.
          this.setStatus('tool_use');
        }
      },
      interjectWaker: () => new Promise<void>((resolve) => {
        // If there are already pending interjects, resolve immediately.
        if (this._pendingInterjects.length > 0) {
          resolve();
          return;
        }
        this._interjectWakers.push(resolve);
      }),
    };
  }

  /**
   * Drain any pending interject messages into a list of Message objects the
   * loop can prepend to the next LLM call. Called inside _queryLoop.
   */
  private drainInterjects(): Message[] {
    if (this._pendingInterjects.length === 0) return [];
    const texts = this._pendingInterjects.splice(0);
    return texts.map((t) => ({
      role: 'user' as const,
      content: t,
      createdAt: Date.now(),
    }));
  }

  constructor(config: AgentConfig) {
    // Base system prompt blocks come from the explicit config when supplied;
    // otherwise the selected prompt pack seeds the base prompt. Additional
    // runtime context (project AGENTS.md, workspace AGENTS.md, skill index)
    // is appended later by buildSystemPrompt().
    const internal = config as InternalAgentConfig;
    this.promptPack = resolvePromptPack(config.promptPack, { directory: config.promptPackDir });
    this.systemPrompt = normalizeSystemPrompt(
      internal._systemPromptOverride
        ?? config.systemPrompt
        ?? this.promptPack.baseAgent,
    );

    if (!config.home) {
      throw new Error(
        'AgentConfig.home is required. Construct `new AgentHome(rootDir)` and pass it in.',
      );
    }
    this._home = config.home;

    // Seed agent.json on first launch with the caller-supplied model ref /
    // compaction / skills / mcp. On subsequent launches the on-disk file is
    // authoritative and these seed values are ignored (AGENTS.md §agent.json).
    const metadata = initWorkspaceSync(this._home.root, {
      model: config.model,
      reasoningEffort: config.reasoningEffort,
      compaction: config.compaction,
      skills: config.skillDirs
        ? { extraDirs: config.skillDirs.map((e) => (typeof e === 'string' ? e : e.dir)) }
        : undefined,
    });

    // Instance-level tool denylist seeds from agent.json.
    this._toolDenylist = new Set(metadata.toolDenylist ?? []);

    this.tools = new Map();
    this.skills = new SkillManager({
      skillDirs: (metadata.skills?.extraDirs ?? []).map((dir) => ({ dir })),
      disabledSkills: new Set(config.disabledSkills ?? []),
    });
    this.cwd = config.cwd ?? process.cwd();
    // Compaction: agent.json wins if set, otherwise fall back to the seed.
    this.compactionConfig = metadata.compaction ?? config.compaction;
    this.compactionStrategy = config.compactionStrategy;
    this.toolGuard = config.toolGuard;
    this.middleware = config.middleware ?? [];

    // Session store: explicit override still wins, otherwise a FileSessionStore
    // rooted at AgentHome.sessionsDir (SDK-owned layout).
    this.sessionStore = config.sessionStore
      ?? new FileSessionStore(this._home.sessionsDir);
    this.onEvent = config.onEvent;

    // Provider: resolver input still wins (for failover wrapping), then
    // agent.json.model resolved via the host resolver, otherwise fall back
    // to the caller-supplied provider config.
    this._modelResolver = config.modelResolver ?? null;
    if (isProviderResolver(config.provider)) {
      this.providerResolver = config.provider as ProviderResolver;
      this.providerConfig = this.providerResolver.resolve();
    } else if (metadata.model && this._modelResolver) {
      // On-disk model ref + host resolver → full ProviderInput.
      const input = this._modelResolver(metadata.model);
      if (isProviderResolver(input)) {
        this.providerResolver = input;
        this.providerConfig = this.providerResolver.resolve();
      } else {
        this.providerResolver = null;
        this.providerConfig = input;
      }
    } else if (metadata.model) {
      // On-disk model ref without registry → treat as bare model id.
      this.providerResolver = null;
      this.providerConfig = { ...config.provider as ProviderConfig, model: metadata.model };
    } else {
      this.providerResolver = null;
      this.providerConfig = config.provider as ProviderConfig;
    }
    // Reasoning effort: on-disk value wins, then caller-supplied config.
    const effort = metadata.reasoningEffort ?? config.reasoningEffort;
    if (effort) {
      this.providerConfig = { ...this.providerConfig, reasoningEffort: effort };
    }
    this._isSubAgent = internal._isSubAgent ?? false;
    this._onQueryStart = config.onQueryStart;
    this._onQueryEnd = config.onQueryEnd;

    // Workspace wiring — event log, memory. initWorkspaceSync above already
    // created the directory tree, so no async workspaceReady gate is needed.
    this.eventLogStore = config.eventLogStore
      ?? new FileEventLogStore(this._home.sessionsDir);
    this._memory = new FileAgentMemory(this._home.root);
    this._memoryProvider = config.memory;

    // Project context
    if (config.project) {
      this._projectContext = new FileProjectContext(config.project);
    }

    // Register tools
    for (const tool of config.tools ?? []) {
      this.tools.set(tool.definition.name, tool);
    }

    // Create provider from the (possibly just-resolved) config.
    this.provider = config.providerInstance ?? createProvider(this.providerConfig);

    // Register built-in load_skill tool when skills are configured.
    // The model calls load_skill(name) via standard tool_use to get full skill body.
    if (this.skills.hasSkillDirs() && !this.tools.has(TOOL_LOAD_SKILL)) {
      this.tools.set(TOOL_LOAD_SKILL, {
        definition: {
          name: TOOL_LOAD_SKILL,
          group: ToolGroup.Agent,
          description: 'Load the full content of a skill by name. Only use when a task matches a skill from the available skills index in the system prompt.',
          inputSchema: {
            type: 'object',
            properties: {
              name: {
                type: 'string',
                description: 'The exact name of the skill to load (from the skills index).',
              },
            },
            required: ['name'],
          },
        },
        execute: async (input) => {
          const skillName = input.name as string;
          const skill = await this.getSkill(skillName);
          if (!skill) {
            return { content: `Skill "${skillName}" not found. Check the available skills in the system prompt.`, isError: true };
          }
          return { content: skill.content };
        },
      });
    }

    // Register built-in delegate tool (unless disabled or this is a sub-agent).
    // Allows the LLM to fork a sub-agent for complex sub-tasks.
    if (!this._isSubAgent && config.enableDelegate !== false && !this.tools.has(TOOL_DELEGATE)) {
      this.tools.set(TOOL_DELEGATE, {
        definition: {
          name: TOOL_DELEGATE,
          group: ToolGroup.Agent,
          description: 'Fork a temporary sub-agent to handle a complex sub-task. ' +
            'The sub-agent inherits your context and tools, executes independently, and returns the result. ' +
            'Use when a task is self-contained and can be done in isolation without further interaction.',
          inputSchema: {
            type: 'object',
            properties: {
              task: {
                type: 'string',
                description: 'Clear description of the sub-task to delegate.',
              },
              allowedTools: {
                type: 'array',
                items: { type: 'string' },
                description: 'Optional: restrict which tools the sub-agent can use (names). If omitted, inherits all.',
              },
            },
            required: ['task'],
          },
        },
        execute: async (input) => {
          try {
            const result = await this.delegate(input.task as string, {
              allowedTools: input.allowedTools as string[] | undefined,
            });
            return {
              content: result.text,
              forUser: `[Delegated: ${(input.task as string).slice(0, 80)}... → ${result.turns} turns, ${result.toolCalls} tool calls]`,
            };
          } catch (err) {
            return { content: `Delegate failed: ${err instanceof Error ? err.message : String(err)}`, isError: true };
          }
        },
      });
    }

    // Persistent sub-agent spawning lives in @berry-agent/team (leader-only
    // `spawn_teammate` tool). The core Agent has no spawn API — `delegate()`
    // is the only in-core way to fork a sub-turn.

    // Register tools from MemoryProvider (if provided).
    if (this._memoryProvider) {
      for (const tool of this._memoryProvider.tools()) {
        this.tools.set(tool.definition.name, tool);
      }
    }

    // Session controller — getters keep refs live so switchModel() /
    // setSystemPrompt() / addTool() all show up without re-wiring the bag.
    this.sessions = new SessionController({
      sessionStore: this.sessionStore,
      eventLogStore: this.eventLogStore,
      projectContext: this._projectContext,
      memory: this._memory,
      compactionConfig: this.compactionConfig,
      compactionStrategy: this.compactionStrategy,
      toolGuardEnabled: !!this.toolGuard,
      getProvider: () => this.provider,
      getProviderConfig: () => this.providerConfig,
      getSystemPrompt: () => this.systemPrompt,
      getPromptPack: () => this.promptPack,
      getTools: () => this.tools,
      interject: (text) => this.interject(text),
      emit: (event, onEvent) => this.emit(event, onEvent),
      buildSystemPrompt: (base) => this.buildSystemPrompt(base),
    });
  }

  /**
   * Simplified agent creation. Sensible defaults:
   * - FileSessionStore at `{home.root}/sessions/`
   * - Default compaction config
   * - No tools (add via `agent.addTool()` or pass `tools`)
   *
   * For full control, use `new Agent(config)` directly.
   */
  static create(config: AgentCreateConfig): Agent {
    if (!config.home) {
      throw new Error(
        'Agent.create: `home` is required. Construct `new AgentHome(rootDir)` and pass it in.',
      );
    }
    const cwd = config.cwd ?? process.cwd();

    // Resolve provider config (or pass-through resolver unchanged).
    // Agent constructor will treat this as a seed on first launch; subsequent
    // launches read provider from agent.json instead.
    let providerConfig: ProviderInput;
    if (config.registry) {
      providerConfig = config.registry.toProviderConfig(config.model);
    } else if (config.provider) {
      providerConfig = config.provider;
    } else {
      // Minimal shorthand: type + apiKey + model
      providerConfig = {
        type: config.providerType ?? 'anthropic',
        apiKey: config.apiKey!,
        baseUrl: config.baseUrl,
        model: config.model!,
        maxTokens: config.maxTokens,
        thinkingBudget: config.thinkingBudget,
        reasoningEffort: config.reasoningEffort,
      };
    }

    return new Agent({
      provider: providerConfig,
      systemPrompt: config.systemPrompt,
      tools: config.tools,
      skillDirs: config.skillDirs,
      disabledSkills: config.disabledSkills,
      cwd,
      sessionStore: config.sessionStore,
      compaction: config.compaction,
      toolGuard: config.toolGuard,
      eventLogStore: config.eventLogStore,
      home: config.home,
      project: config.project,
      middleware: config.middleware,
      onEvent: config.onEvent,
      promptPack: config.promptPack,
      promptPackDir: config.promptPackDir,
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
    if (this._status === 'destroyed') {
      throw new Error('Agent has been destroyed; create a new instance to continue');
    }

    // Reset provider resolver so that transient errors from a previous query
    // don't permanently brick the model. Each query starts with a clean slate.
    this.providerResolver?.resetForSession?.();

    // 1. Resolve session (new / resume / fork)
    const session = await this.resolveSession(options);

    // 1b. Repair corrupted sessions: if the last assistant message contains
    // tool_use blocks but the next message is NOT a tool_result user message,
    // inject synthetic tool_result blocks so the API doesn't reject the whole
    // conversation. This can happen when stop_reason was incorrectly reported
    // as 'end_turn' despite tool_use content being present.
    repairOrphanToolUses(session.messages);

    const emit = (event: AgentEvent) => this.emit(event, options?.onEvent);
    const log = this.eventLogStore;
    const turnId = log ? generateTurnId() : undefined;

    // Helper: build and append a session event (no-op when log is not configured)
    const makeBase = () => ({
      id: generateEventId(),
      timestamp: Date.now(),
      sessionId: session.id,
      turnId,
    });
    const appendEvent = async (event: SessionEvent): Promise<void> => {
      if (!log) return;
      await log.append(session.id, event);
    };

    // Lifecycle hook: onQueryStart
    if (this._onQueryStart) {
      await this._onQueryStart(session, prompt);
    }

    // Event log: query_start
    await appendEvent({ ...makeBase(), type: 'query_start', prompt });
    emit({ type: 'query_start', prompt, sessionId: session.id });

    // 2. Add user message
    session.messages.push({
      role: 'user',
      content: prompt,
      createdAt: Date.now(),
    });
    await appendEvent({ ...makeBase(), type: 'user_message', content: prompt });

    this._querying = true;
    this.setStatus('tool_use', 'thinking');

    // Wrap main loop in try-catch to guarantee query_end is always emitted.
    // Without this, errors cause turns to stay "active" forever.
    try {
      const result = await this._queryLoop(session, prompt, options, emit, appendEvent, makeBase, log, turnId);
      // Lifecycle hook: onQueryEnd
      if (this._onQueryEnd) {
        await this._onQueryEnd(session, result);
      }
      return result;
    } catch (err) {
      // Emit error query_end so the turn is marked as failed, not stuck "active".
      // Status is reset to idle in the finally block below.
      const errorResult: QueryResult = {
        text: '',
        sessionId: session.id,
        usage: { inputTokens: 0, outputTokens: 0 },
        totalUsage: {
          inputTokens: session.metadata.totalInputTokens,
          outputTokens: session.metadata.totalOutputTokens,
          cacheReadTokens: session.metadata.totalCacheReadTokens,
          cacheWriteTokens: session.metadata.totalCacheWriteTokens,
        },
        toolCalls: 0,
        compacted: false,
        error: err instanceof Error ? err.message : String(err),
      };
      await appendEvent({ ...makeBase(), type: 'query_end', result: errorResult }).catch(() => {});
      emit({ type: 'query_end', result: errorResult });
      // Lifecycle hook: onQueryEnd (even on error)
      if (this._onQueryEnd) {
        try { await this._onQueryEnd(session, errorResult); } catch { /* ignore */ }
      }
      throw err;
    } finally {
      this._querying = false;
      // Runtime check: destroy() may have fired concurrently. The TS narrowing
      // here is stale (status was set to 'tool_use' before this try block).
      if ((this._status as AgentStatus) !== 'destroyed') this.setStatus('idle');
    }
  }

  /** Internal: the actual agent loop, extracted for try-catch in send(). */
  private async _queryLoop(
    session: Session,
    prompt: string | ContentBlock[],
    options: QueryOptions | undefined,
    emit: (event: AgentEvent) => void,
    appendEvent: (event: SessionEvent) => Promise<void>,
    makeBase: () => { id: string; timestamp: number; sessionId: string; turnId?: string },
    log: EventLogStore | undefined,
    turnId: string | undefined,
  ): Promise<QueryResult> {
    // 3. Resolve tools for this query
    const allowedTools = this.resolveAllowedTools(options?.allowedTools, session);

    // 4. Build system prompt (static blocks + dynamic skills)
    const fullSystemPrompt = await this.buildSystemPrompt(this.systemPrompt, options?.systemPrompt);
    let compacted = false;

    // 4b. Soft compaction at turn entry (before entering the agent loop).
    //     Soft compaction runs cheap layers that may modify messages and break
    //     the prompt cache prefix — so it must NOT be checked inside the
    //     per-inference loop, where it would destroy cache hits every iteration.
    const ctxWindow = this.compactionConfig?.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
    if (shouldSoftCompact({ session, systemPrompt: this.systemPrompt, compactionConfig: this.compactionConfig, contextWindow: ctxWindow })) {
      // If hard threshold is also crossed, prefer hard (it includes all soft layers + more)
      const compactLevel: 'soft' | 'hard' = shouldHardCompact({ session, systemPrompt: this.systemPrompt, compactionConfig: this.compactionConfig, contextWindow: ctxWindow }) ? 'hard' : 'soft';

      if (compactLevel === 'hard' && this._memory) {
        this.setStatus('tool_use', 'memory_flushing');
        await preCompactMemoryFlush({
          session,
          memory: this._memory!,
          provider: this.provider,
          systemPrompt: fullSystemPrompt,
          promptPack: this.promptPack,
          emit,
          appendEvent,
          makeBase,
        });
      }

      this.setStatus('tool_use', `compacting:${compactLevel}`);
      await this.runCompactionWithMiddleware(
        session,
        {
          level: compactLevel,
          reason: 'threshold',
          tokensBefore: session.metadata.lastInputTokens ?? 0,
        },
        () => runCompaction({
          compactionStrategy: this.compactionStrategy,
          session,
          compactionConfig: this.compactionConfig,
          compactLevel,
          provider: this.provider,
          systemPrompt: fullSystemPrompt,
          promptPack: this.promptPack,
          allowedTools,
          emit,
          appendEvent,
          makeBase,
        }),
      );
      compacted = true;
    }

    // 5. Agent loop (tool calling)
    let turns = 0;
    const maxTurns = options?.maxTurns ?? DEFAULT_MAX_TURNS;
    let totalUsage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
    let toolCallCount = 0;

    while (turns < maxTurns) {
      turns++;

      // 5a. Hard compaction check before each LLM inference.
      //     After the previous turn's tool execution, token count may have
      //     spiked past the hard threshold. A hard compact here prevents
      //     prompt-too-long errors on the next API call.
      if (shouldHardCompact({ session, systemPrompt: this.systemPrompt, compactionConfig: this.compactionConfig, contextWindow: ctxWindow })) {
        if (this._memory) {
          this.setStatus('tool_use', 'memory_flushing');
          await preCompactMemoryFlush({
            session,
            memory: this._memory!,
            provider: this.provider,
            systemPrompt: fullSystemPrompt,
            promptPack: this.promptPack,
            emit,
            appendEvent,
            makeBase,
          });
        }

        this.setStatus('tool_use', 'compacting:hard');
        await this.runCompactionWithMiddleware(
          session,
          {
            level: 'hard',
            reason: 'threshold',
            tokensBefore: session.metadata.lastInputTokens ?? 0,
          },
          () => runCompaction({
            compactionStrategy: this.compactionStrategy,
            session,
            compactionConfig: this.compactionConfig,
            compactLevel: 'hard',
            provider: this.provider,
            systemPrompt: fullSystemPrompt,
            promptPack: this.promptPack,
            allowedTools,
            emit,
            appendEvent,
            makeBase,
          }),
        );
        compacted = true;
      }

      this.setStatus('tool_use', 'thinking');

      // Drain any pending interject messages into the session so the upcoming
      // LLM call sees them. Interjects are always treated as user messages.
      const interjects = this.drainInterjects();
      if (interjects.length > 0) {
        session.messages.push(...interjects);
        for (const msg of interjects) {
          const text = typeof msg.content === 'string' ? msg.content : '';
          await appendEvent({ ...makeBase(), type: 'user_message', content: text });
        }
      }

      // messages.json is the provider-context source of truth. Persist the
      // current mutations first, then read back exactly what the provider sees.
      let messagesForProvider = await this.persistAndReadProviderMessages(session);

      // 5b. Call provider (with PTL recovery)
      emit({
        type: 'api_call',
        messages: messagesForProvider.length,
        tools: allowedTools.length,
      });

      // Event log: api_request (full body) + api_response (full body)
      const requestId = generateEventId();
      await appendEvent({
        ...makeBase(),
        type: 'api_request',
        requestId,
        model: this.providerConfig.model,
        messages: messagesForProvider,
        tools: allowedTools.map(t => ({ name: t.definition.name, description: t.definition.description })),
        params: { maxTokens: this.providerConfig.maxTokens, thinkingBudget: this.providerConfig.thinkingBudget },
        contextManifest: this.buildContextManifest(fullSystemPrompt, messagesForProvider, allowedTools),
      });

      let response: import('./types.js').ProviderResponse;
      let ptlRetries = 0;

      while (true) {
        let providerRequest: ProviderRequest = {
          systemPrompt: fullSystemPrompt,
          messages: messagesForProvider,
          tools: allowedTools.map(t => t.definition),
          signal: options?.abortSignal,
          responseFormat: options?.responseFormat,
        };
        const mwCtx = this.getMiddlewareContext(session);

        try {
          // Middleware: onBeforeApiCall
          for (const mw of this.middleware) {
            if (mw.onBeforeApiCall) {
              providerRequest = await mw.onBeforeApiCall(providerRequest, mwCtx);
            }
          }

          response = await this.callProvider(providerRequest, options?.stream === true, emit);

          // Middleware: onAfterApiCall
          for (const mw of this.middleware) {
            if (mw.onAfterApiCall) {
              await mw.onAfterApiCall(providerRequest, response, mwCtx);
            }
          }

          break; // Success
        } catch (err) {
          if (isPromptTooLongError(err) && ptlRetries < MAX_PTL_RETRIES) {
            ptlRetries++;
            const learnedContextWindow = extractContextWindowFromError(err);
            if (
              learnedContextWindow &&
              learnedContextWindow > 0 &&
              learnedContextWindow < (this.compactionConfig?.contextWindow ?? ctxWindow)
            ) {
              this.compactionConfig = {
                ...this.compactionConfig,
                contextWindow: learnedContextWindow,
              };
            }
            // Force compaction to shrink context, then retry
            this.setStatus('tool_use', `compacting:${COMPACTION_TRIGGER_REASON.OVERFLOW_RETRY}`);
            await this.runCompactionWithMiddleware(
              session,
              {
                level: 'hard',
                reason: 'overflow_retry',
                tokensBefore: session.metadata.lastInputTokens ?? estimateTokens(session.messages),
              },
              () => runCompaction({
                compactionStrategy: this.compactionStrategy,
                session,
                compactionConfig: this.compactionConfig,
                compactLevel: 'hard',
                provider: this.provider,
                systemPrompt: fullSystemPrompt,
                promptPack: this.promptPack,
                allowedTools,
                emit: (event: AgentEvent) => {
                  // Override triggerReason for PTL recovery events
                  if (event.type === 'compaction') {
                    emit({ ...event, triggerReason: COMPACTION_TRIGGER_REASON.OVERFLOW_RETRY });
                    return;
                  }
                  emit(event);
                },
                appendEvent: async (event: SessionEvent) => {
                  // Override strategy for PTL recovery events
                  if ('type' in event && event.type === 'compaction_marker') {
                    await appendEvent({
                      ...event,
                      strategy: COMPACTION_TRIGGER_REASON.OVERFLOW_RETRY,
                      triggerReason: COMPACTION_TRIGGER_REASON.OVERFLOW_RETRY,
                    } as SessionEvent);
                    return;
                  }
                  await appendEvent(event);
                },
                makeBase,
              }),
            );
            compacted = true;
            messagesForProvider = await this.persistAndReadProviderMessages(session);
            // Retry with compacted messages
            continue;
          }
          // Final failure — notify middleware so observe can record the failed call
          for (const mw of this.middleware) {
            if (mw.onApiCallError) {
              try { await mw.onApiCallError(providerRequest, err, mwCtx); } catch { /* ignore */ }
            }
          }
          throw err; // Non-PTL error or retries exhausted
        }
      }

      // Event log: api_response with full response body
      await appendEvent({
        ...makeBase(),
        type: 'api_response',
        requestId,
        model: this.providerConfig.model,
        content: response.content,
        stopReason: response.stopReason,
        usage: {
          inputTokens: response.usage.inputTokens,
          outputTokens: response.usage.outputTokens,
          cacheReadTokens: response.usage.cacheReadTokens,
          cacheWriteTokens: response.usage.cacheWriteTokens,
        },
      });

      emit({
        type: 'api_response',
        usage: response.usage,
        stopReason: response.stopReason,
        model: this.providerConfig.model,
      });

      // 5c. Accumulate usage
      totalUsage = accumulateUsage(totalUsage, response.usage);
      session.metadata.totalInputTokens += response.usage.inputTokens;
      session.metadata.totalOutputTokens += response.usage.outputTokens;
      session.metadata.totalCacheReadTokens += response.usage.cacheReadTokens ?? 0;
      session.metadata.totalCacheWriteTokens += response.usage.cacheWriteTokens ?? 0;

      // Track last known TOTAL input tokens for compaction decisions.
      if (this.provider.type === 'anthropic') {
        session.metadata.lastInputTokens =
          response.usage.inputTokens +
          (response.usage.cacheReadTokens ?? 0) +
          (response.usage.cacheWriteTokens ?? 0);
      } else {
        // OpenAI and compatible: inputTokens is already the total
        session.metadata.lastInputTokens = response.usage.inputTokens;
      }

      // 5d. Add assistant message to session
      session.messages.push({
        role: 'assistant',
        content: response.content,
        createdAt: Date.now(),
      });
      await appendEvent({ ...makeBase(), type: 'assistant_message', content: response.content });

      // 5e. If no tool calls → done
      // DEFENSIVE: check actual content for tool_use blocks, not just stopReason.
      // Anthropic streaming can sometimes lose stop_reason='tool_use' (e.g. if
      // message_delta arrives with null stop_reason). Trusting only stopReason
      // would skip tool execution, leaving orphan tool_use blocks in the session
      // that permanently corrupt it (Anthropic rejects messages without matching
      // tool_result blocks).
      const toolUses = (response.content as ContentBlock[]).filter(
        (b): b is ToolUseContent => b.type === 'tool_use',
      );
      if (response.stopReason !== 'tool_use' && toolUses.length === 0) {
        break;
      }
      // Auto-correct stopReason if content has tool_use but API said end_turn
      if (response.stopReason !== 'tool_use' && toolUses.length > 0) {
        response.stopReason = 'tool_use';
      }
      this.setStatus('tool_use', toolUses.map(t => t.name).join(', '));

      const mwCtx = this.getMiddlewareContext(session);

      const execResult = await executeTools({
        toolUses,
        tools: new Map(allowedTools.map(tool => [tool.definition.name, tool])),
        toolGuard: this.toolGuard,
        middleware: this.middleware,
        session,
        emit,
        appendEvent,
        makeBase,
        middlewareContext: mwCtx,
        cwd: this.cwd,
        model: this.providerConfig.model,
        abortSignal: options?.abortSignal,
      });

      toolCallCount += execResult.toolCalls;
      this.setStatus('tool_use', 'thinking');

      // Add all tool results as one user message
      session.messages.push({
        role: 'user',
        content: execResult.results,
        createdAt: Date.now(),
      });

      // Incremental save after each tool loop turn.
      session.lastAccessedAt = Date.now();
      await this.sessionStore.save(session);

      // Loop continues → next API call with tool results
    }

    // 6. Persist final session state. messages.json remains the provider
    // context source of truth; events.jsonl is append-only audit/UI history.
    session.lastAccessedAt = Date.now();
    await this.sessionStore.save(session);

    // 7. Extract final text
    const text = extractText(session.messages[session.messages.length - 1]);

    const result: QueryResult = {
      text,
      sessionId: session.id,
      usage: totalUsage,
      totalUsage: {
        inputTokens: session.metadata.totalInputTokens,
        outputTokens: session.metadata.totalOutputTokens,
        cacheReadTokens: session.metadata.totalCacheReadTokens,
        cacheWriteTokens: session.metadata.totalCacheWriteTokens,
      },
      toolCalls: toolCallCount,
      compacted,
    };

    // Event log: query_end
    await appendEvent({ ...makeBase(), type: 'query_end', result });

    // DURABILITY: messages_snapshot — checkpoint the complete messages[]
    // after every successful turn so crash recovery can resume from here
    // instead of replaying all events from the beginning.
    if (log) {
      await appendEvent({
        ...makeBase(),
        type: 'messages_snapshot',
        messages: session.messages,
        reason: 'turn_end',
      });
    }

    this._lastSessionId = session.id;
    emit({ type: 'query_end', result });
    return result;
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

  /** Register an additional tool at runtime */
  addTool(tool: ToolRegistration): void {
    this.tools.set(tool.definition.name, tool);
  }

  /**
   * Switch the model used by this agent. Accepts a model-ref string that
   * follows the same conventions as the `provider` field at construction:
   *
   *   - `'tier:fast'`  / `'tier:strong'` / `'tier:balanced'`
   *   - `'model:claude-sonnet-4-20250514'`
   *   - `'raw:...'`
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
    if (this._modelResolver) {
      const input = this._modelResolver(modelRef);
      if (isProviderResolver(input)) {
        this.providerResolver = input;
        this.providerConfig = this.providerResolver.resolve();
      } else {
        this.providerResolver = null;
        this.providerConfig = input;
      }
    } else {
      // No registry — treat as a bare model id, keep existing provider type/key/baseUrl.
      this.providerResolver = null;
      this.providerConfig = { ...this.providerConfig, model: modelRef };
    }
    this.provider = createProvider(this.providerConfig);
    saveAgentConfigSync(this._home.root, { model: modelRef });
  }

  /**
   * Override the reasoning effort level on the current provider config.
   * Takes effect on the next LLM inference. Persisted to agent.json.
   */
  setReasoningEffort(effort: ReasoningEffort): void {
    this.providerResolver = null;
    this.providerConfig = { ...this.providerConfig, reasoningEffort: effort };
    this.provider = createProvider(this.providerConfig);
    saveAgentConfigSync(this._home.root, { reasoningEffort: effort });
  }

  /** Get current provider config (read-only) */
  get currentProvider(): Readonly<ProviderConfig> {
    return { ...this.providerConfig };
  }

  // ===== Hot reload API =====
  //
  // These mutators let a host product reconfigure a running
  // Agent without destroying the instance, so sessions/memory/pending
  // interjects survive. Changes take effect on the next LLM inference.

  /** Replace the user-facing system prompt blocks. */
  setSystemPrompt(blocks: SystemPromptInput): void {
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

  private buildContextManifest(
    systemPrompt: readonly SystemPromptBlock[],
    messages: readonly Message[],
    allowedTools: readonly ToolRegistration[],
  ): import('./event-log/types.js').ContextManifest {
    return {
      promptPackVersion: this.promptPack.version,
      messageSource: 'messages.json',
      messageCount: messages.length,
      systemBlockCount: systemPrompt.length,
      systemBlockHashes: systemPrompt.map((block) => shortHash(block.text)),
      toolCount: allowedTools.length,
      toolsHash: shortHash(allowedTools.map((tool) => tool.definition)),
    };
  }

  /** Register (or replace by name) a single tool. */
  registerTool(registration: ToolRegistration): void {
    this.tools.set(registration.definition.name, registration);
  }

  /** Remove a tool by name. Returns true if removed. */
  unregisterTool(name: string): boolean {
    return this.tools.delete(name);
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
  // Four observable states:
  //   idle      — waiting for input
  //   tool_use  — running a turn (LLM call, tool execution, compaction — all fold here)
  //   sleeping  — suspended by the sleep tool; interject() wakes
  //   destroyed — terminal; every further call rejects
  //
  // There is no pause/resume. `send()` is the single turn entry point.
  // `delegate()` forks a sub-turn; the agent stays in tool_use throughout.

  /**
   * Terminal shutdown. Destroys all child agents, clears pending interjects,
   * and marks the instance unusable. After destroy():
   *   - send() / delegate() reject
   *   - registerTool / setSystemPrompt / setToolDenylist throw
   *   - introspection still works so the product can render a final view
   *
   * Idempotent — calling destroy() twice is a no-op.
   */
  destroy(): void {
    if (this._status === 'destroyed') return;
    // Tear down children first so their own stores / tasks exit cleanly
    for (const [id, child] of this._children.entries()) {
      try {
        child.destroy();
      } catch (err) {
        // Never let a rogue child block the parent's teardown
        console.warn(`[agent] destroying child ${id} threw:`, err);
      }
    }
    this._children.clear();

    // Drop pending interjects + wake anything sleeping so awaiters don't leak
    this._pendingInterjects = [];
    const wakers = this._interjectWakers.splice(0);
    for (const w of wakers) {
      try { w(); } catch { /* noop */ }
    }

    this.setStatus('destroyed');
  }

  /** True once destroy() has completed. */
  get isDestroyed(): boolean {
    return this._status === 'destroyed';
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
      providerConfig: this.providerConfig,
      systemPrompt: this.systemPrompt,
      tools: this.tools,
      loadedSkills: this.skills.loadedSnapshot,
      cwd: this.cwd,
      middleware: this.middleware,
      toolGuard: this.toolGuard,
      workspaceRoot: this._home.root,
      memory: this._memory,
      compactionConfig: this.compactionConfig,
      compactionStrategy: this.compactionStrategy,
      eventLogStore: this.eventLogStore,
      children: this._children,
      status: this._status,
      statusDetail: this._statusDetail,
    };
  }

  /** Remove a tool at runtime */
  removeTool(name: string): boolean {
    return this.tools.delete(name);
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
        status: this._status,
        lastSessionId: this._lastSessionId,
        sessionStore: this.sessionStore,
        providerConfig: this.providerConfig,
        provider: this.provider,
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

  /** Get all active sub-agents (currently only populated by delegate-style helpers). */
  get children(): ReadonlyMap<string, Agent> {
    return this._children;
  }

  /** Destroy a sub-agent */
  destroyChild(id: string): boolean {
    const deleted = this._children.delete(id);
    if (deleted) this.emit({ type: 'child_destroyed', childId: id });
    return deleted;
  }

  /** Whether this agent is a sub-agent */
  get isSubAgent(): boolean {
    return this._isSubAgent;
  }

  /** Agent memory (available when workspace is configured). */
  get memory(): AgentMemory | undefined {
    return this._memory;
  }

  /** Project context (available when project is configured). */
  get projectContext(): ProjectContext | undefined {
    return this._projectContext;
  }

  // ===== Internal Methods =====

  private getMiddlewareContext(session: Session): MiddlewareContext {
    return {
      sessionId: session.id,
      model: this.providerConfig.model,
      provider: this.providerConfig.type,
      cwd: this.cwd,
    };
  }

  /**
   * Fire `onBeforeCompact` / `onAfterCompact` around a compaction call.
   * Middleware errors are swallowed so an observer failure never aborts
   * compaction — the agent's token-pressure logic must not depend on
   * observe collectors succeeding.
   */
  private async runCompactionWithMiddleware(
    session: Session,
    compactCtx: import('./types.js').CompactionContext,
    run: () => Promise<import('./compaction-runner.js').RunCompactionResult>,
  ): Promise<import('./compaction-runner.js').RunCompactionResult> {
    const mwCtx = this.getMiddlewareContext(session);
    for (const mw of this.middleware) {
      if (mw.onBeforeCompact) {
        try { await mw.onBeforeCompact(compactCtx, mwCtx); } catch { /* ignore */ }
      }
    }
    const result = await run();
    const outcome: import('./types.js').CompactionOutcome = {
      tokensFreed: result.result.tokensFreed,
      layersApplied: [...result.result.layersApplied],
      durationMs: result.durationMs,
    };
    for (const mw of this.middleware) {
      if (mw.onAfterCompact) {
        try { await mw.onAfterCompact(compactCtx, outcome, mwCtx); } catch { /* ignore */ }
      }
    }
    return result;
  }

  private async resolveSession(options?: QueryOptions): Promise<Session> {
    return this.sessions.resolveSession(options);
  }

  private resolveAllowedTools(allowed?: string[], session?: Session): ToolRegistration[] {
    const registered = [...this.tools.values()];
    const runtime = createRuntimeTools({
      session,
      sleepSignal: this.createSleepSignal(),
      onTodoChange: (s, state) => {
        this.emit({
          type: 'todo_updated',
          sessionId: s.id,
          todos: state.items,
          timestamp: state.updatedAt,
        });
      },
    });
    const merged = mergeToolsByName(registered, runtime);

    // Runtime tools (memory/todo/sleep) are exempt from the per-query allow-list
    // (keeps memory etc. always-on unless the denylist explicitly rejects them).
    const runtimeNames = new Set(runtime.map(t => t.definition.name));
    const applyAllow = (tool: ToolRegistration, set?: Set<string>): boolean => {
      if (!set) return true;
      if (runtimeNames.has(tool.definition.name)) return true;
      return set.has(tool.definition.name);
    };

    // 1. Per-query allow-list (if provided) narrows user-registered tools.
    const afterAllow = allowed
      ? merged.filter(t => applyAllow(t, new Set(allowed)))
      : merged;

    // 2. Instance-level denylist strips names unconditionally. Applied last so
    // a product can guarantee certain tools are off regardless of allowedTools.
    if (this._toolDenylist.size === 0) return afterAllow;
    return afterAllow.filter(t => !this._toolDenylist.has(t.definition.name));
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
    if (override !== undefined) return normalizeSystemPrompt(override);

    const base = normalizeSystemPrompt(basePrompt);

    // Append project context after the SDK base prompt. Later blocks are
    // product/project/agent-specific, while the base block stays reusable.
    if (this._projectContext) {
      const ctx = await this._projectContext.loadContext();
      if (ctx) base.push({ text: ctx, cache: SystemPromptCacheMode.Stable });
    }

    // Append AGENTS.md from workspace (if exists)
    try {
      const { readFile } = await import('node:fs/promises');
      const agentMd = await readFile(this._home.agentMdPath, 'utf-8');
      if (agentMd.trim()) base.push({ text: agentMd, cache: SystemPromptCacheMode.Stable });
    } catch {
      // AGENTS.md doesn't exist or is empty — skip
    }

    // Skill system: inject lightweight index (name + description + whenToUse).
    // Full content is loaded lazily when the skill is invoked.
    const index = await this.skills.renderIndexBlock();
    if (index) base.push({ text: index, cache: SystemPromptCacheMode.Dynamic });

    return base;
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
   * If a resolver is attached, pull the latest ProviderConfig from it and
   * rebuild `this.provider` when the config materially changed. Called at
   * the start of every provider call.
   */
  private refreshProviderIfNeeded(): void {
    if (!this.providerResolver) return;
    const next = this.providerResolver.resolve();
    if (!providerConfigsEqual(this.providerConfig, next)) {
      this.providerConfig = next;
      this.provider = createProvider(next);
    }
  }

  /**
   * Forward a provider-side error to the resolver (if any). Never throws —
   * the agent loop still owns whether to retry or surface the error.
   */
  private reportProviderError(err: unknown, statusCode?: number): void {
    if (!this.providerResolver?.reportError) return;
    const isTransient =
      typeof statusCode === 'number'
        ? statusCode === 402 || statusCode === 408 || statusCode === 429 || statusCode >= 500
        : isRetryableError(err);
    try {
      this.providerResolver.reportError(err, { isTransient, statusCode });
    } catch {
      /* resolver errors must not poison the agent */
    }
  }

  private async callProvider(
    request: ProviderRequest,
    stream: boolean,
    emit: (event: AgentEvent) => void,
  ): Promise<import('./types.js').ProviderResponse> {
    return callProvider(
      {
        getProvider: () => this.provider,
        refreshIfNeeded: () => this.refreshProviderIfNeeded(),
        reportError: (err, statusCode) => this.reportProviderError(err, statusCode),
      },
      request,
      stream,
      emit,
    );
  }

  private emit(event: AgentEvent, queryOnEvent?: (event: AgentEvent) => void): void {
    this.onEvent?.(event);
    queryOnEvent?.(event);
  }
}
