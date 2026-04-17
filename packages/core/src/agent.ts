// ============================================================
// Berry Agent SDK — Agent Core
// ============================================================
// The main Agent class. Pure library, no CLI dependency.
// Manages: agent loop, tools, sessions, compaction, cache.

import type {
  AgentConfig,
  AgentCreateConfig,
  QueryOptions,
  QueryResult,
  Message,
  Provider,
  ProviderConfig,
  ProviderRequest,
  ToolRegistration,
  Session,
  SessionMetadata,
  SessionStore,
  ContentBlock,
  ToolUseContent,
  TokenUsage,
  AgentEvent,
  ToolGuard,
  DelegateConfig,
  DelegateResult,
  SpawnConfig,
  Middleware,
  MiddlewareContext,
  ToolDefinition,
  TodoItem,
} from './types.js';
import type { EventLogStore, SessionEvent, ContextStrategy } from './event-log/types.js';
import { DefaultContextStrategy } from './event-log/context-builder.js';
import { FileEventLogStore } from './event-log/jsonl-store.js';
import { AnthropicProvider } from './providers/anthropic.js';
import { OpenAIProvider } from './providers/openai.js';
import type { AgentMemory, MemorySearchProvider, ProjectContext } from './workspace/types.js';
import { FileAgentMemory } from './workspace/file-memory.js';
import { FileProjectContext } from './workspace/file-project.js';
import { initWorkspace } from './workspace/initializer.js';
import { estimateTokens, type ForkContext } from './compaction/compactor.js';
import type { CompactionStrategy } from './compaction/types.js';
import { DefaultCompactionStrategy } from './compaction/compactor.js';
import { loadSkillsFromDir, buildSkillIndex } from './skills/loader.js';
import type { Skill } from './skills/types.js';
import { FileSessionStore } from './session/file-store.js';
import type { ProviderRegistry } from './registry.js';
import {
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_COMPACTION_RATIO,
  DEFAULT_SOFT_COMPACTION_RATIO,
  DEFAULT_SOFT_LAYERS,
  DEFAULT_MAX_TURNS,
  MAX_PTL_RETRIES,
  REQUEST_TIMEOUT_MS,
} from './constants.js';
import { TOOL_LOAD_SKILL, TOOL_DELEGATE, TOOL_SPAWN } from './tool-names.js';
import { executeTools } from './tool-executor.js';
import {
  shouldCompact,
  runCompaction,
  preCompactMemoryFlush,
} from './compaction-runner.js';
import { createRuntimeTools, getRuntimeToolDefinitions } from './runtime-tools.js';

/** Internal config extension for sub-agent creation (not part of public API). */
interface InternalAgentConfig extends AgentConfig {
  _isSubAgent?: boolean;
}

export class Agent {
  private provider: Provider;
  private providerConfig: ProviderConfig;
  private systemPrompt: string[];
  private tools: Map<string, ToolRegistration>;
  private legacySkills: string[];  // deprecated: raw .md paths
  private skillDirs: string[];
  private loadedSkills: Skill[] | null = null;  // lazy-loaded
  private cwd: string;
  private sessionStore: SessionStore;
  private compactionConfig: AgentConfig['compaction'];
  private compactionStrategy?: CompactionStrategy;
  private onEvent?: (event: AgentEvent) => void;
  private toolGuard?: ToolGuard;
  private middleware: Middleware[];
  private eventLogStore?: EventLogStore;
  private contextStrategy: ContextStrategy;
  private _memory?: AgentMemory;
  private _memorySearch?: MemorySearchProvider;
  private _projectContext?: ProjectContext;
  private _workspaceRoot?: string;
  private _workspaceReady?: Promise<void>;
  private _children = new Map<string, Agent>();
  private _isSubAgent = false;
  private _lastSessionId?: string;
  private _querying = false;
  private _status: import('./types.js').AgentStatus = 'idle';
  private _statusDetail?: string;

  // Interject mechanism — see interject() + sleep tool wiring
  private _pendingInterjects: string[] = [];
  private _interjectWakers: Array<() => void> = [];
  private _sleepDepth = 0;

  // Lifecycle hooks
  private _onQueryStart?: (session: Session, prompt: string) => void | Promise<void>;
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
   *   - Use `query()` for queued / next-turn messages (normal user prompts).
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
          // Return to tool_executing; the outer loop will reset status after.
          this.setStatus('tool_executing');
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
    // Normalize system prompt to array of blocks
    this.systemPrompt = Array.isArray(config.systemPrompt)
      ? config.systemPrompt
      : [config.systemPrompt];

    this.tools = new Map();
    this.legacySkills = config.skills ?? [];
    this.skillDirs = config.skillDirs ?? [];
    this.cwd = config.cwd ?? process.cwd();
    this.compactionConfig = config.compaction;
    this.compactionStrategy = config.compactionStrategy;
    this.toolGuard = config.toolGuard;
    this.middleware = config.middleware ?? [];
    this.sessionStore = config.sessionStore ?? createInMemoryStore();
    this.onEvent = config.onEvent;
    this.providerConfig = config.provider;
    this.contextStrategy = new DefaultContextStrategy();
    this._isSubAgent = (config as InternalAgentConfig)._isSubAgent ?? false;
    this._onQueryStart = config.onQueryStart;
    this._onQueryEnd = config.onQueryEnd;

    // Workspace: auto-wire event log, memory, and system prompt from AGENT.md
    if (config.workspace) {
      this._workspaceRoot = config.workspace;
      // Auto-create EventLogStore if user didn't provide one
      if (!config.eventLogStore) {
        this.eventLogStore = new FileEventLogStore(config.workspace);
      } else {
        this.eventLogStore = config.eventLogStore;
      }
      this._memory = new FileAgentMemory(config.workspace);
      // Kick off workspace init in background (idempotent); query() awaits before first use
      this._workspaceReady = initWorkspace(config.workspace).then(() => {});
    } else {
      this.eventLogStore = config.eventLogStore;
    }
    this._memorySearch = config.memorySearch;

    // Project context
    if (config.project) {
      this._projectContext = new FileProjectContext(config.project);
    }

    // Register tools
    for (const tool of config.tools ?? []) {
      this.tools.set(tool.definition.name, tool);
    }

    // Create provider
    this.provider = config.providerInstance ?? createProvider(config.provider);

    // Register built-in load_skill tool when skills are configured.
    // The model calls load_skill(name) via standard tool_use to get full skill body.
    if (this.skillDirs.length > 0 && !this.tools.has(TOOL_LOAD_SKILL)) {
      this.tools.set(TOOL_LOAD_SKILL, {
        definition: {
          name: TOOL_LOAD_SKILL,
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

    // Register built-in spawn_agent tool (unless disabled or this is a sub-agent).
    // Allows the LLM to create persistent sub-agents for ongoing work.
    if (!this._isSubAgent && config.enableSpawn !== false && !this.tools.has(TOOL_SPAWN)) {
      this.tools.set(TOOL_SPAWN, {
        definition: {
          name: TOOL_SPAWN,
          description: 'Create a persistent sub-agent with its own system prompt and conversation history. ' +
            'Unlike delegate (one-shot), a spawned agent persists and can be queried multiple times. ' +
            'Use for long-running specialist roles (e.g., a code reviewer, a researcher).',
          inputSchema: {
            type: 'object',
            properties: {
              id: {
                type: 'string',
                description: 'Unique ID for this sub-agent (e.g., "reviewer", "researcher").',
              },
              systemPrompt: {
                type: 'string',
                description: 'System prompt defining the sub-agent\'s role and behavior.',
              },
              task: {
                type: 'string',
                description: 'Initial task/message to send to the sub-agent.',
              },
              inheritTools: {
                type: 'boolean',
                description: 'Whether to inherit parent tools (default: true).',
              },
            },
            required: ['id', 'systemPrompt', 'task'],
          },
        },
        execute: async (input) => {
          try {
            const childId = input.id as string;
            // Check if already exists
            let child = this._children.get(childId);
            if (!child) {
              child = this.spawn({
                id: childId,
                systemPrompt: input.systemPrompt as string,
                inheritTools: input.inheritTools !== false,
              });
            }
            const result = await child.query(input.task as string);
            return {
              content: result.text,
              forUser: `[Sub-agent "${childId}": ${result.toolCalls} tool calls, ${result.usage.inputTokens + result.usage.outputTokens} tokens]`,
            };
          } catch (err) {
            return { content: `Spawn failed: ${err instanceof Error ? err.message : String(err)}`, isError: true };
          }
        },
      });
    }
  }

  // ===== Static Factory =====

  /**
   * Simplified agent creation. Sensible defaults:
   * - FileSessionStore at `{cwd}/.berry-sessions/`
   * - Default compaction config
   * - No tools (add via `agent.addTool()` or pass `tools`)
   *
   * For full control, use `new Agent(config)` directly.
   */
  static create(config: AgentCreateConfig): Agent {
    const cwd = config.cwd ?? process.cwd();

    // Resolve provider config
    let providerConfig: ProviderConfig;
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
      };
    }

    // Session store: file-based by default
    const sessionsDir = config.sessionsDir ?? `${cwd}/.berry-sessions`;
    const sessionStore = config.sessionStore ?? new FileSessionStore(sessionsDir);

    return new Agent({
      provider: providerConfig,
      systemPrompt: config.systemPrompt ?? 'You are a helpful AI assistant.',
      tools: config.tools,
      skillDirs: config.skillDirs,
      cwd,
      sessionStore,
      compaction: config.compaction,
      toolGuard: config.toolGuard,
      eventLogStore: config.eventLogStore,
      workspace: config.workspace,
      memorySearch: config.memorySearch,
      project: config.project,
      middleware: config.middleware,
      onEvent: config.onEvent,
    });
  }

  /**
   * Send a message to the agent and get a response.
   * Handles: tool loop, compaction, cache, session persistence.
   * When eventLogStore is configured, appends events for every action
   * and rebuilds context from the event log via ContextStrategy.
   */
  async query(prompt: string, options?: QueryOptions): Promise<QueryResult> {
    // Ensure workspace is initialized before first query
    if (this._workspaceReady) await this._workspaceReady;

    // 1. Resolve session (new / resume / fork)
    const session = await this.resolveSession(options);
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
    this.setStatus('thinking');

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
      this.setStatus('error', err instanceof Error ? err.message : String(err));
      // Emit error query_end so the turn is marked as failed, not stuck "active"
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
      // Preserve 'error' so UI can observe the failure. Observers that
      // want to reset can do so explicitly; the next query() transitions
      // back to 'thinking' anyway.
      if (this._status !== 'error') this.setStatus('idle');
    }
  }

  /** Internal: the actual agent loop, extracted for try-catch in query(). */
  private async _queryLoop(
    session: Session,
    prompt: string,
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
    const fullSystemPrompt = await this.buildSystemPrompt(session.systemPrompt, options?.systemPrompt);

    // 5. Agent loop (tool calling)
    let turns = 0;
    const maxTurns = options?.maxTurns ?? DEFAULT_MAX_TURNS;
    let totalUsage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
    let compacted = false;
    let toolCallCount = 0;

    while (turns < maxTurns) {
      turns++;

      // 5a. Two-tier compaction BEFORE API call
      const ctxWindow = this.compactionConfig?.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
      const compactLevel = shouldCompact({
        session,
        compactionConfig: this.compactionConfig,
        contextWindow: ctxWindow,
      });

      // Pre-compact memory flush: save important context to memory before hard compact
      if (compactLevel === 'hard' && this._memory) {
        this.setStatus('memory_flushing');
        await preCompactMemoryFlush({
          session,
          memory: this._memory,
          provider: this.provider,
          systemPrompt: fullSystemPrompt,
          emit,
          appendEvent,
          makeBase,
        });
      }

      if (compactLevel !== 'none') {
        this.setStatus('compacting', compactLevel);
        await runCompaction({
          compactionStrategy: this.compactionStrategy,
          session,
          compactionConfig: this.compactionConfig,
          compactLevel,
          provider: this.provider,
          systemPrompt: fullSystemPrompt,
          allowedTools,
          emit,
          appendEvent,
          makeBase,
        });
        compacted = true;
      }

      this.setStatus('thinking');

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

      // If event log is configured, rebuild messages from the log
      const messagesForProvider = log
        ? this.contextStrategy.buildMessages(await log.getEvents(session.id))
        : session.messages;

      // 5b. Call provider (with PTL recovery)
      emit({
        type: 'api_call',
        messages: messagesForProvider.length,
        tools: allowedTools.length,
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

        try {
          // Middleware: onBeforeApiCall
          const mwCtx = this.getMiddlewareContext(session);
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
            // Force compaction to shrink context, then retry
            this.setStatus('compacting', 'overflow_retry');
            await runCompaction({
          compactionStrategy: this.compactionStrategy,
              session,
              compactionConfig: this.compactionConfig,
              compactLevel: 'hard',
              provider: this.provider,
              systemPrompt: fullSystemPrompt,
              allowedTools,
              emit: (event: AgentEvent) => {
                // Override triggerReason for PTL recovery events
                if (event.type === 'compaction') {
                  emit({ ...event, triggerReason: 'overflow_retry' });
                  return;
                }
                emit(event);
              },
              appendEvent: async (event: SessionEvent) => {
                // Override strategy for PTL recovery events
                if ('type' in event && event.type === 'compaction_marker') {
                  await appendEvent({
                    ...event,
                    strategy: 'overflow_retry',
                    triggerReason: 'overflow_retry',
                  } as SessionEvent);
                  return;
                }
                await appendEvent(event);
              },
              makeBase,
            });
            compacted = true;
            // Retry with compacted messages
            continue;
          }
          throw err; // Non-PTL error or retries exhausted
        }
      }

      // Event log: api_call metadata
      await appendEvent({
        ...makeBase(),
        type: 'api_call',
        model: this.providerConfig.model,
        inputTokens: response.usage.inputTokens,
        outputTokens: response.usage.outputTokens,
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
      if (response.stopReason !== 'tool_use') {
        break;
      }

      // 5f. Execute tool calls
      const toolUses = (response.content as ContentBlock[]).filter(
        (b): b is ToolUseContent => b.type === 'tool_use',
      );
      this.setStatus('tool_executing', toolUses.map(t => t.name).join(', '));

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
        abortSignal: options?.abortSignal,
      });

      toolCallCount += execResult.toolCalls;
      this.setStatus('thinking');

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

    // 6. Persist session (skip when event log is source of truth)
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

    this._lastSessionId = session.id;
    emit({ type: 'query_end', result });
    return result;
  }

  // ===== Public API =====

  /** Get a session by ID. When event log is configured, rebuilds from log. */
  async getSession(id: string): Promise<Session | null> {
    if (this.eventLogStore) {
      const events = await this.eventLogStore.getEvents(id);
      const stored = await this.sessionStore.load(id);
      if (events.length === 0) return stored; // fallback
      return {
        id,
        messages: this.contextStrategy.buildMessages(events),
        systemPrompt: stored?.systemPrompt ?? this.systemPrompt,
        createdAt: stored?.createdAt ?? events[0].timestamp,
        lastAccessedAt: stored?.lastAccessedAt ?? events[events.length - 1].timestamp,
        metadata: stored?.metadata ?? createEmptySessionMetadata(this.cwd, this.providerConfig.model),
      };
    }
    return this.sessionStore.load(id);
  }

  /** List all session IDs. When event log is configured, lists from log. */
  async listSessions(): Promise<string[]> {
    if (this.eventLogStore) {
      return this.eventLogStore.listSessions();
    }
    return this.sessionStore.list();
  }

  /** Register an additional tool at runtime */
  addTool(tool: ToolRegistration): void {
    this.tools.set(tool.definition.name, tool);
  }

  /**
   * Switch provider and/or model at runtime. Sessions are preserved.
   * Accepts a full ProviderConfig or a partial override (model-only switch).
   */
  switchProvider(config: ProviderConfig | { model: string }): void {
    if ('type' in config) {
      // Full provider switch
      this.providerConfig = config;
      this.provider = createProvider(config);
    } else {
      // Model-only switch (same provider type/key/baseUrl)
      this.providerConfig = { ...this.providerConfig, model: config.model };
      this.provider = createProvider(this.providerConfig);
    }
  }

  /** Get current provider config (read-only) */
  get currentProvider(): Readonly<ProviderConfig> {
    return { ...this.providerConfig };
  }

  // ===== Introspection =====

  /** Get current system prompt blocks */
  getSystemPrompt(): readonly string[] {
    return [...this.systemPrompt];
  }

  /** Get all registered tool definitions */
  getTools(): ToolDefinition[] {
    const registered = [...this.tools.values()];
    // Use a lightweight signal here — this path only needs definitions.
    const runtime = getRuntimeToolDefinitions({
      memory: this._memory,
      memorySearch: this._memorySearch,
      sleepSignal: {
        onEnter: () => {},
        onExit: () => {},
        interjectWaker: () => new Promise(() => {}),
      },
    }).map((definition) => ({
      definition,
      execute: async () => ({ content: '' }),
    }));

    return mergeToolsByName(registered, runtime).map(t => t.definition);
  }

  /** Get loaded skill metadata (empty if skills not yet loaded) */
  getSkillMetas(): Array<{ name: string; description: string; dir: string }> {
    if (!this.loadedSkills) return [];
    return this.loadedSkills.map(s => ({
      name: s.meta.name,
      description: s.meta.description,
      dir: s.dir,
    }));
  }

  /** Get current working directory */
  getCwd(): string {
    return this.cwd;
  }

  /** Full introspection snapshot */
  inspect(): {
    provider: Readonly<ProviderConfig>;
    systemPrompt: string[];
    tools: ToolDefinition[];
    skills: Array<{ name: string; description: string; dir: string }>;
    cwd: string;
    middleware: number;
    hasToolGuard: boolean;
    workspace?: string;
    memory?: { available: boolean };
    compaction?: {
      threshold: number;
      softThreshold: number;
      contextWindow: number;
      enabledLayers?: string[];
    };
    eventLog?: { available: boolean };
    hasCustomCompaction: boolean;
    children: string[];
    status: import('./types.js').AgentStatus;
    statusDetail?: string;
  } {
    const ctxWindow = this.compactionConfig?.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
    return {
      provider: this.currentProvider,
      systemPrompt: [...this.systemPrompt],
      tools: this.getTools(),
      skills: this.getSkillMetas(),
      cwd: this.cwd,
      middleware: this.middleware.length,
      hasToolGuard: !!this.toolGuard,
      workspace: this._workspaceRoot,
      memory: { available: !!this._memory },
      compaction: {
        threshold: this.compactionConfig?.threshold ?? Math.floor(ctxWindow * DEFAULT_COMPACTION_RATIO),
        softThreshold: this.compactionConfig?.softThreshold ?? Math.floor(ctxWindow * DEFAULT_SOFT_COMPACTION_RATIO),
        contextWindow: ctxWindow,
        enabledLayers: this.compactionConfig?.enabledLayers,
      },
      eventLog: { available: !!this.eventLogStore },
      hasCustomCompaction: !!this.compactionStrategy,
      children: [...this._children.keys()],
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
    const previousStatus = this._status;
    this.setStatus('delegating');
    const emit = (event: AgentEvent) => {
      this.onEvent?.(event);
      config?.onEvent?.(event);
    };

    // Stable sessionId for entire delegate lifecycle (fixes FK + observe consistency)
    const delegateSessionId = `delegate_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    // Emit query_start so observe collector creates the session row before any llm_calls
    emit({ type: 'query_start', sessionId: delegateSessionId, prompt: message });
    emit({ type: 'delegate_start', message });

    // Build system prompt for the delegate
    let delegateSystemPrompt: string[];
    if (config?.overrideSystemPrompt) {
      delegateSystemPrompt = normalizeSystemPrompt(config.overrideSystemPrompt);
    } else {
      // Start with main agent's system prompt (cache sharing)
      delegateSystemPrompt = await this.buildSystemPrompt(this.systemPrompt);
      if (config?.appendSystemPrompt) {
        const extra = normalizeSystemPrompt(config.appendSystemPrompt);
        delegateSystemPrompt = [...delegateSystemPrompt, ...extra];
      }
    }

    // Build conversation prefix (main agent's messages for cache sharing)
    let contextMessages: Message[] = [];
    if (config?.includeHistory !== false) {
      const sid = config?.sessionId ?? this._lastSessionId;
      if (sid) {
        const session = await this.sessionStore.load(sid);
        if (session) contextMessages = [...session.messages];
      }
    }

    // Build messages: context prefix + delegate prompt
    const messages: Message[] = [
      ...contextMessages,
      { role: 'user' as const, content: message, createdAt: Date.now() },
    ];

    const delegateSession: Session = {
      id: delegateSessionId,
      messages,
      systemPrompt: delegateSystemPrompt,
      createdAt: Date.now(),
      lastAccessedAt: Date.now(),
      metadata: createEmptySessionMetadata(this.cwd, config?.model ?? this.providerConfig.model),
    };

    // Resolve tools
    let delegateTools = this.resolveAllowedTools(config?.allowedTools, delegateSession);
    if (config?.additionalTools) {
      delegateTools = mergeToolsByName(config.additionalTools, delegateTools);
    }

    // Create a transient provider (same instance for cache sharing, or new for model override)
    const delegateProvider = config?.model
      ? createProvider({ ...this.providerConfig, model: config.model })
      : this.provider;

    const delegateGuard = config?.toolGuard ?? this.toolGuard;

    // Run the delegate's tool loop
    let delegateTurns = 0;
    const maxTurns = config?.maxTurns ?? DEFAULT_MAX_TURNS;
    let totalUsage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
    let toolCalls = 0;
    const toolMap = new Map(delegateTools.map(t => [t.definition.name, t]));

    try {
      while (delegateTurns < maxTurns) {
      delegateTurns++;

      let request: ProviderRequest = {
        systemPrompt: delegateSystemPrompt,
        messages,
        tools: delegateTools.map(t => t.definition),
        signal: config?.abortSignal,
      };

      // Middleware: onBeforeApiCall (reuse stable delegateSessionId across all turns)
      const mwCtx: MiddlewareContext = {
        sessionId: delegateSessionId,
        model: config?.model ?? this.providerConfig.model,
        provider: this.providerConfig.type,
        cwd: this.cwd,
      };
      for (const mw of this.middleware) {
        if (mw.onBeforeApiCall) request = await mw.onBeforeApiCall(request, mwCtx);
      }

      const response = await (config?.stream && delegateProvider.stream
        ? this.callProvider_delegate(delegateProvider, request, emit)
        : delegateProvider.chat(request));

      // Middleware: onAfterApiCall
      for (const mw of this.middleware) {
        if (mw.onAfterApiCall) await mw.onAfterApiCall(request, response, mwCtx);
      }

      totalUsage = accumulateUsage(totalUsage, response.usage);
      emit({ type: 'api_response', usage: response.usage, stopReason: response.stopReason, model: config?.model ?? this.providerConfig.model });

      // Add assistant message
      messages.push({ role: 'assistant', content: response.content, createdAt: Date.now() });

      if (response.stopReason !== 'tool_use') break;

      // Execute tools
      const toolUses = (response.content as ContentBlock[]).filter(
        (b): b is ToolUseContent => b.type === 'tool_use',
      );
      const toolResultBlocks: ContentBlock[] = [];

      for (const toolUse of toolUses) {
        toolCalls++;
        const tool = toolMap.get(toolUse.name);
        if (!tool) {
          toolResultBlocks.push({ type: 'tool_result', toolUseId: toolUse.id, content: `Error: unknown tool "${toolUse.name}"`, isError: true });
          continue;
        }

        let guardedInput = toolUse.input;
        if (delegateGuard) {
          const decision = await delegateGuard({ toolName: toolUse.name, input: toolUse.input, session: { id: mwCtx.sessionId, cwd: this.cwd, model: mwCtx.model }, callIndex: toolCalls });
          if (decision.action === 'deny') {
            toolResultBlocks.push({ type: 'tool_result', toolUseId: toolUse.id, content: `Permission denied: ${decision.reason}`, isError: true });
            continue;
          }
          if (decision.action === 'modify') guardedInput = decision.input;
        }

        try {
          // Middleware: onBeforeToolExec
          for (const mw of this.middleware) {
            if (mw.onBeforeToolExec) guardedInput = await mw.onBeforeToolExec(toolUse.name, guardedInput, mwCtx);
          }
          const result = await tool.execute(guardedInput, { cwd: this.cwd, abortSignal: config?.abortSignal });
          // Middleware: onAfterToolExec
          for (const mw of this.middleware) {
            if (mw.onAfterToolExec) await mw.onAfterToolExec(toolUse.name, guardedInput, result, mwCtx);
          }
          toolResultBlocks.push({ type: 'tool_result', toolUseId: toolUse.id, content: result.forLLM ?? result.content, isError: result.isError });
        } catch (err) {
          toolResultBlocks.push({ type: 'tool_result', toolUseId: toolUse.id, content: `Error: ${err instanceof Error ? err.message : String(err)}`, isError: true });
        }
      }

      messages.push({ role: 'user', content: toolResultBlocks, createdAt: Date.now() });
    }

      const lastMsg = messages[messages.length - 1];
      const text = extractText(lastMsg);
      const result: DelegateResult = { text, usage: totalUsage, turns: delegateTurns, toolCalls };
      emit({ type: 'delegate_end', result });
      return result;
    } finally {
      this.setStatus(previousStatus);
    }
  }

  private async callProvider_delegate(
    provider: Provider,
    request: ProviderRequest,
    emit: (event: AgentEvent) => void,
  ): Promise<import('./types.js').ProviderResponse> {
    if (!provider.stream) return provider.chat(request);
    let finalResponse: import('./types.js').ProviderResponse | null = null;
    for await (const event of provider.stream(request)) {
      if (event.type === 'text_delta') emit({ type: 'text_delta', text: event.text });
      else if (event.type === 'thinking_delta') emit({ type: 'thinking_delta', thinking: event.thinking });
      else if (event.type === 'response') finalResponse = event.response;
    }
    if (!finalResponse) throw new Error('Provider stream ended without a final response');
    return finalResponse;
  }

  // ===== Spawn (persistent sub-agent) =====

  /**
   * Create a persistent sub-agent. Inherits provider by default.
   * Sub-agents cannot spawn further sub-agents.
   */
  spawn(config: SpawnConfig): Agent {
    if (this._isSubAgent) {
      throw new Error('Sub-agents cannot spawn further sub-agents');
    }

    const id = config.id ?? `child_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

    // Merge tools
    let tools: ToolRegistration[];
    if (config.tools && config.inheritTools !== false) {
      // Specified tools + parent's tools
      tools = [...this.tools.values(), ...config.tools];
    } else if (config.tools) {
      tools = config.tools;
    } else {
      tools = [...this.tools.values()]; // inherit all
    }

    const childConfig: InternalAgentConfig = {
      provider: config.model
        ? { ...this.providerConfig, model: config.model }
        : this.providerConfig,
      // Share provider instance for cache sharing (only when same model)
      providerInstance: config.model ? undefined : this.provider,
      systemPrompt: config.systemPrompt,
      tools,
      cwd: config.cwd ?? this.cwd,
      compaction: config.compaction ?? this.compactionConfig,
      toolGuard: config.toolGuard ?? this.toolGuard,
      middleware: this.middleware,
      onEvent: this.onEvent,
      sessionStore: config.sessionStore ?? this.sessionStore,
      eventLogStore: this.eventLogStore,
      memorySearch: this._memorySearch,
      _isSubAgent: true,
    };
    const child = new Agent(childConfig);

    this._children.set(id, child);
    this.emit({ type: 'child_spawned', childId: id });
    return child;
  }

  /** Get all active sub-agents */
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
      model: session.metadata.model,
      provider: this.providerConfig.type,
      cwd: session.metadata.cwd,
    };
  }

  private async resolveSession(options?: QueryOptions): Promise<Session> {
    if (options?.resume) {
      // When event log is configured, rebuild session from event log (source of truth)
      if (this.eventLogStore) {
        const events = await this.eventLogStore.getEvents(options.resume);
        const stored = await this.sessionStore.load(options.resume);
        if (events.length === 0) {
          // No events — maybe a legacy session, fall back to session store
          const session = stored;
          if (!session) throw new Error(`Session not found: ${options.resume}`);
          if (options.systemPrompt) {
            session.systemPrompt = normalizeSystemPrompt(options.systemPrompt);
          }
          return session;
        }
        // Rebuild messages from event log
        const messages = this.contextStrategy.buildMessages(events);
        const session: Session = {
          id: options.resume,
          messages,
          systemPrompt: options.systemPrompt
            ? normalizeSystemPrompt(options.systemPrompt)
            : stored?.systemPrompt ?? this.systemPrompt,
          createdAt: stored?.createdAt ?? events[0].timestamp,
          lastAccessedAt: stored?.lastAccessedAt ?? events[events.length - 1].timestamp,
          metadata: stored?.metadata ?? createEmptySessionMetadata(this.cwd, this.providerConfig.model),
        };
        return session;
      }
      const session = await this.sessionStore.load(options.resume);
      if (!session) throw new Error(`Session not found: ${options.resume}`);
      if (options.systemPrompt) {
        session.systemPrompt = normalizeSystemPrompt(options.systemPrompt);
      }
      return session;
    }
    if (options?.fork) {
      const source = await this.sessionStore.load(options.fork);
      if (!source) throw new Error(`Session not found: ${options.fork}`);
      return {
        ...structuredClone(source),
        id: generateId(),
        createdAt: Date.now(),
        lastAccessedAt: Date.now(),
      };
    }
    // New session
    return {
      id: generateId(),
      messages: [],
      systemPrompt: this.systemPrompt,
      createdAt: Date.now(),
      lastAccessedAt: Date.now(),
      metadata: createEmptySessionMetadata(this.cwd, this.providerConfig.model),
    };
  }

  private resolveAllowedTools(allowed?: string[], session?: Session): ToolRegistration[] {
    const registered = [...this.tools.values()];
    const runtime = createRuntimeTools({
      memory: this._memory,
      memorySearch: this._memorySearch,
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

    if (!allowed) return merged;

    const allowedSet = new Set(allowed);
    return merged.filter((tool) => allowedSet.has(tool.definition.name));
  }

  /**
   * Get the current todo list for a session. Returns an empty array if
   * no todos have been set yet.
   */
  async getTodos(sessionId: string): Promise<TodoItem[]> {
    const session = await this.sessionStore.load(sessionId);
    if (!session) return [];
    return session.metadata.todo?.items ?? [];
  }

  private async buildSystemPrompt(basePrompt: string[], override?: string | string[]): Promise<string[]> {
    if (override) return normalizeSystemPrompt(override);

    const base = [...basePrompt];

    // Prepend project context if available
    if (this._projectContext) {
      const ctx = await this._projectContext.loadContext();
      if (ctx) base.unshift(ctx);
    }

    // Append AGENT.md from workspace (if exists)
    if (this._workspaceRoot) {
      try {
        const { readFile } = await import('node:fs/promises');
        const { join } = await import('node:path');
        const agentMd = await readFile(join(this._workspaceRoot, 'AGENT.md'), 'utf-8');
        if (agentMd.trim()) base.push(agentMd);
      } catch {
        // AGENT.md doesn't exist or is empty — skip
      }
    }

    // Legacy skill loading (deprecated: injects full content)
    if (this.legacySkills.length > 0) {
      const skillContent = await this.loadLegacySkills();
      if (skillContent) base.push(skillContent);
    }

    // New skill system: inject lightweight index (name + description + whenToUse)
    // Full content is loaded lazily when the skill is invoked.
    if (this.skillDirs.length > 0) {
      const skills = await this.getLoadedSkills();
      const index = buildSkillIndex(skills);
      if (index) base.push(index);
    }

    return base;
  }

  /** Lazy-load skills from all skill directories (cached). */
  private async getLoadedSkills(): Promise<Skill[]> {
    if (this.loadedSkills) return this.loadedSkills;

    const allSkills: Skill[] = [];
    for (const dir of this.skillDirs) {
      const skills = await loadSkillsFromDir(dir);
      allSkills.push(...skills);
    }

    // Deduplicate by name (first wins)
    const seen = new Set<string>();
    this.loadedSkills = allSkills.filter(s => {
      if (seen.has(s.meta.name)) return false;
      seen.add(s.meta.name);
      return true;
    });

    return this.loadedSkills;
  }

  /** Get a loaded skill by name (for lazy content loading). */
  async getSkill(name: string): Promise<Skill | null> {
    const skills = await this.getLoadedSkills();
    return skills.find(s => s.meta.name === name) ?? null;
  }

  /** Get all loaded skill indexes. */
  async getSkillIndexes(): Promise<Array<{ name: string; description: string; whenToUse?: string }>> {
    const skills = await this.getLoadedSkills();
    return skills.map(s => ({ name: s.meta.name, description: s.meta.description, whenToUse: s.meta.whenToUse }));
  }

  private async loadLegacySkills(): Promise<string | null> {
    const { readFile } = await import('node:fs/promises');
    const parts: string[] = [];
    for (const path of this.legacySkills) {
      try {
        const content = await readFile(path, 'utf-8');
        parts.push(content);
      } catch {
        // Skip unreadable skills
      }
    }
    return parts.length > 0 ? parts.join('\n\n') : null;
  }

  private async callProvider(
    request: ProviderRequest,
    stream: boolean,
    emit: (event: AgentEvent) => void,
  ): Promise<import('./types.js').ProviderResponse> {
    if (stream && this.provider.stream) {
      let finalResponse: import('./types.js').ProviderResponse | null = null;

      // Stream idle timeout: abort if no data received for REQUEST_TIMEOUT_MS.
      // Prevents indefinite hangs when the provider stream stalls.
      const idleController = new AbortController();
      let idleTimer: ReturnType<typeof setTimeout> | null = null;
      const resetIdle = () => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => idleController.abort(), REQUEST_TIMEOUT_MS);
      };

      // Compose with caller's abort signal
      const composedSignal = request.signal
        ? AbortSignal.any([request.signal, idleController.signal])
        : idleController.signal;

      const streamRequest: ProviderRequest = { ...request, signal: composedSignal };

      try {
        resetIdle();
        for await (const event of this.provider.stream(streamRequest)) {
          resetIdle();
          if (event.type === 'text_delta') {
            emit({ type: 'text_delta', text: event.text });
          } else if (event.type === 'thinking_delta') {
            emit({ type: 'thinking_delta', thinking: event.thinking });
          } else if (event.type === 'response') {
            finalResponse = event.response;
          }
        }
      } finally {
        if (idleTimer) clearTimeout(idleTimer);
      }

      if (!finalResponse) {
        throw new Error('Provider stream ended without a final response');
      }

      return finalResponse;
    }

    return this.provider.chat(request);
  }

  private emit(event: AgentEvent, queryOnEvent?: (event: AgentEvent) => void): void {
    this.onEvent?.(event);
    queryOnEvent?.(event);
  }
}

// ===== Provider Factory =====

function createProvider(config: ProviderConfig): Provider {
  switch (config.type) {
    case 'anthropic':
      return new AnthropicProvider(config);
    case 'openai':
      return new OpenAIProvider(config);
    default:
      throw new Error(`Unknown provider type: ${config.type}`);
  }
}

// ===== Helpers =====

function generateId(): string {
  return `ses_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeSystemPrompt(prompt: string | string[]): string[] {
  return Array.isArray(prompt) ? prompt : [prompt];
}

function extractText(message: Message): string {
  if (!message) return '';
  if (typeof message.content === 'string') return message.content;
  return message.content
    .filter((b): b is import('./types.js').TextContent => b.type === 'text')
    .map(b => b.text)
    .join('\n');
}

function accumulateUsage(total: TokenUsage, delta: TokenUsage): TokenUsage {
  return {
    inputTokens: total.inputTokens + delta.inputTokens,
    outputTokens: total.outputTokens + delta.outputTokens,
    cacheReadTokens: (total.cacheReadTokens ?? 0) + (delta.cacheReadTokens ?? 0),
    cacheWriteTokens: (total.cacheWriteTokens ?? 0) + (delta.cacheWriteTokens ?? 0),
  };
}

function generateEventId(): string {
  return `evt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function generateTurnId(): string {
  return `turn_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function createInMemoryStore(): SessionStore {
  const sessions = new Map<string, Session>();
  return {
    save: async (s) => { sessions.set(s.id, structuredClone(s)); },
    load: async (id) => {
      const s = sessions.get(id);
      return s ? structuredClone(s) : null;
    },
    list: async () => [...sessions.keys()],
    delete: async (id) => { sessions.delete(id); },
  };
}

function createEmptySessionMetadata(cwd: string, model: string): SessionMetadata {
  return {
    cwd,
    model,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheWriteTokens: 0,
    compactionCount: 0,
  };
}

function mergeToolsByName(primary: ToolRegistration[], secondary: ToolRegistration[]): ToolRegistration[] {
  const merged = new Map<string, ToolRegistration>();

  for (const tool of secondary) {
    merged.set(tool.definition.name, tool);
  }

  for (const tool of primary) {
    merged.set(tool.definition.name, tool);
  }

  return [...merged.values()];
}

/**
 * Detect "prompt too long" errors from various providers.
 *
 * Anthropic: status 400, error.type = 'invalid_request_error',
 *   message contains 'prompt is too long' or 'too many tokens'
 * OpenAI: status 400, code = 'context_length_exceeded'
 */
function isPromptTooLongError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as Record<string, unknown>;

  // Anthropic SDK: BadRequestError with message about prompt length
  const msg = (typeof e.message === 'string' ? e.message : '').toLowerCase();
  if (
    msg.includes('prompt is too long') ||
    msg.includes('too many tokens') ||
    msg.includes('context_length_exceeded') ||
    msg.includes('maximum context length')
  ) {
    return true;
  }

  // OpenAI SDK: error.code === 'context_length_exceeded'
  if (e.code === 'context_length_exceeded') return true;
  const nested = e.error;
  if (nested && typeof nested === 'object' && (nested as Record<string, unknown>).code === 'context_length_exceeded') return true;

  return false;
}
