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
} from './types.js';
import type { EventLogStore, SessionEvent, ContextStrategy } from './event-log/types.js';
import { DefaultContextStrategy } from './event-log/context-builder.js';
import { AnthropicProvider } from './providers/anthropic.js';
import { OpenAIProvider } from './providers/openai.js';
import { compact, estimateTokens, type ForkContext } from './compaction/compactor.js';
import { loadSkillsFromDir, buildSkillIndex } from './skills/loader.js';
import type { Skill } from './skills/types.js';
import { FileSessionStore } from './session/file-store.js';
import type { ProviderRegistry } from './registry.js';
import {
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_COMPACTION_RATIO,
  DEFAULT_MAX_TURNS,
  MAX_PTL_RETRIES,
} from './constants.js';
import { TOOL_LOAD_SKILL, TOOL_DELEGATE, TOOL_SPAWN } from './tool-names.js';

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
  private onEvent?: (event: AgentEvent) => void;
  private toolGuard?: ToolGuard;
  private middleware: Middleware[];
  private eventLogStore?: EventLogStore;
  private contextStrategy: ContextStrategy;
  private _children = new Map<string, Agent>();
  private _isSubAgent = false;
  private _lastSessionId?: string;

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
    this.toolGuard = config.toolGuard;
    this.middleware = config.middleware ?? [];
    this.sessionStore = config.sessionStore ?? createInMemoryStore();
    this.onEvent = config.onEvent;
    this.providerConfig = config.provider;
    this.eventLogStore = config.eventLogStore;
    this.contextStrategy = new DefaultContextStrategy();
    this._isSubAgent = (config as InternalAgentConfig)._isSubAgent ?? false;

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

    // 3. Resolve tools for this query
    const allowedTools = this.resolveAllowedTools(options?.allowedTools);

    // 4. Build system prompt (static blocks + dynamic skills)
    const fullSystemPrompt = await this.buildSystemPrompt(session.systemPrompt, options?.systemPrompt);

    // 5. Agent loop (tool calling)
    let turns = 0;
    const maxTurns = options?.maxTurns ?? DEFAULT_MAX_TURNS;
    let totalUsage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
    let compacted = false;
    let toolCalls = 0;

    while (turns < maxTurns) {
      turns++;

      // 5a. Check compaction BEFORE API call
      // Prefer real usage from last API response; fall back to char-based estimate
      if (this.shouldCompact(session)) {
        const ctxWindow = this.compactionConfig?.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
        const contextBefore = session.metadata.lastInputTokens ?? estimateTokens(session.messages);
        const thresholdPct = contextBefore / ctxWindow;
        // Build fork context for cache-sharing
        const forkCtx: ForkContext = {
          systemPrompt: fullSystemPrompt,
          tools: allowedTools.map(t => t.definition),
        };
        const compactStart = Date.now();
        const result = await compact(
          session.messages,
          {
            contextWindow: ctxWindow,
            threshold: this.compactionConfig?.threshold,
            enabledLayers: this.compactionConfig?.enabledLayers,
          },
          this.provider,
          forkCtx,
        );
        const compactDuration = Date.now() - compactStart;
        const contextAfter = estimateTokens(result.messages);
        session.messages = result.messages;
        session.metadata.compactionCount++;
        compacted = true;

        // Event log: compaction_marker
        await appendEvent({
          ...makeBase(),
          type: 'compaction_marker',
          strategy: 'threshold',
          tokensFreed: result.tokensFreed,
        });

        emit({
          type: 'compaction',
          layersApplied: result.layersApplied,
          tokensFreed: result.tokensFreed,
          triggerReason: 'threshold',
          contextBefore,
          contextAfter,
          thresholdPct,
          contextWindow: ctxWindow,
          durationMs: compactDuration,
        });
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
            const ptlCtxWindow = this.compactionConfig?.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
            const ptlContextBefore = session.metadata.lastInputTokens ?? estimateTokens(session.messages);
            const ptlThresholdPct = ptlContextBefore / ptlCtxWindow;
            // Force compaction to shrink context, then retry
            const ptlForkCtx: ForkContext = {
              systemPrompt: fullSystemPrompt,
              tools: allowedTools.map(t => t.definition),
            };
            const ptlStart = Date.now();
            const ptlResult = await compact(
              session.messages,
              {
                contextWindow: ptlCtxWindow,
                threshold: this.compactionConfig?.threshold,
                enabledLayers: this.compactionConfig?.enabledLayers,
              },
              this.provider,
              ptlForkCtx,
            );
            const ptlDuration = Date.now() - ptlStart;
            const ptlContextAfter = estimateTokens(ptlResult.messages);
            session.messages = ptlResult.messages;
            session.metadata.compactionCount++;
            compacted = true;

            // Event log: compaction_marker (PTL recovery)
            await appendEvent({
              ...makeBase(),
              type: 'compaction_marker',
              strategy: 'overflow_retry',
              tokensFreed: ptlResult.tokensFreed,
            });

            emit({
              type: 'compaction',
              layersApplied: ptlResult.layersApplied,
              tokensFreed: ptlResult.tokensFreed,
              triggerReason: 'overflow_retry',
              contextBefore: ptlContextBefore,
              contextAfter: ptlContextAfter,
              thresholdPct: ptlThresholdPct,
              contextWindow: ptlCtxWindow,
              durationMs: ptlDuration,
            });
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
      //
      // Anthropic: input_tokens = only uncached portion.
      //   Total context = input_tokens + cache_read + cache_creation.
      // OpenAI: prompt_tokens already includes cached tokens.
      //   cached_tokens is a SUBSET, not additive.
      //
      // Provider type determines the correct formula.
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

      // Collect all tool results into a single user message
      // (Anthropic expects tool_result blocks in the same user message)
      // Execute all tool calls in PARALLEL (independent tools have no deps)

      // Emit all tool_call events first
      for (const toolUse of toolUses) {
        toolCalls++;
        emit({ type: 'tool_call', name: toolUse.name, input: toolUse.input });
      }

      const mwCtx = this.getMiddlewareContext(session);

      const toolResultBlocks: ContentBlock[] = await Promise.all(
        toolUses.map(async (toolUse): Promise<ContentBlock> => {
          const tool = this.tools.get(toolUse.name);
          if (!tool) {
            emit({ type: 'tool_result', name: toolUse.name, isError: true });
            return {
              type: 'tool_result',
              toolUseId: toolUse.id,
              content: `Error: unknown tool "${toolUse.name}"`,
              isError: true,
            };
          }

          // Event log: tool_use
          await appendEvent({
            ...makeBase(),
            type: 'tool_use',
            name: toolUse.name,
            toolUseId: toolUse.id,
            input: toolUse.input,
          });

          // Tool guard check
          let guardedInput = toolUse.input;
          if (this.toolGuard) {
            const guardStart = Date.now();
            const decision = await this.toolGuard({
              toolName: toolUse.name,
              input: toolUse.input,
              session: {
                id: session.id,
                cwd: session.metadata.cwd,
                model: session.metadata.model,
              },
              callIndex: toolCalls,
            });
            const guardDuration = Date.now() - guardStart;

            // Event log: guard_decision
            await appendEvent({
              ...makeBase(),
              type: 'guard_decision',
              toolName: toolUse.name,
              decision,
            });

            emit({
              type: 'guard_decision',
              toolName: toolUse.name,
              input: toolUse.input,
              decision,
              callIndex: toolCalls,
              durationMs: guardDuration,
            });

            if (decision.action === 'deny') {
              const denyContent = `Permission denied: ${decision.reason}`;
              // Event log: tool_result (denied)
              await appendEvent({
                ...makeBase(),
                type: 'tool_result',
                toolUseId: toolUse.id,
                content: denyContent,
                isError: true,
              });
              emit({ type: 'tool_result', name: toolUse.name, isError: true });
              return {
                type: 'tool_result',
                toolUseId: toolUse.id,
                content: denyContent,
                isError: true,
              };
            }
            if (decision.action === 'modify') {
              guardedInput = decision.input;
            }
          }

          try {
            // Middleware: onBeforeToolExec
            for (const mw of this.middleware) {
              if (mw.onBeforeToolExec) {
                guardedInput = await mw.onBeforeToolExec(toolUse.name, guardedInput, mwCtx);
              }
            }

            const result = await tool.execute(guardedInput, {
              cwd: this.cwd,
              abortSignal: options?.abortSignal,
            });

            // Middleware: onAfterToolExec
            for (const mw of this.middleware) {
              if (mw.onAfterToolExec) {
                await mw.onAfterToolExec(toolUse.name, guardedInput, result, mwCtx);
              }
            }

            const resultContent = result.forLLM ?? result.content;
            // Event log: tool_result
            await appendEvent({
              ...makeBase(),
              type: 'tool_result',
              toolUseId: toolUse.id,
              content: resultContent,
              isError: result.isError ?? false,
            });

            emit({ type: 'tool_result', name: toolUse.name, isError: result.isError ?? false });
            return {
              type: 'tool_result',
              toolUseId: toolUse.id,
              content: resultContent,
              isError: result.isError,
            };
          } catch (err) {
            const errContent = `Error: ${err instanceof Error ? err.message : String(err)}`;
            // Event log: tool_result (error)
            await appendEvent({
              ...makeBase(),
              type: 'tool_result',
              toolUseId: toolUse.id,
              content: errContent,
              isError: true,
            });

            emit({ type: 'tool_result', name: toolUse.name, isError: true });
            return {
              type: 'tool_result',
              toolUseId: toolUse.id,
              content: errContent,
              isError: true,
            };
          }
        }),
      );

      // Add all tool results as one user message
      session.messages.push({
        role: 'user',
        content: toolResultBlocks,
        createdAt: Date.now(),
      });

      // Incremental save after each tool loop turn.
      // This ensures that if the process crashes mid-loop, we lose at most
      // one turn of work (the next assistant response). The tool results
      // and prior messages are already persisted.
      session.lastAccessedAt = Date.now();
      await this.sessionStore.save(session);

      // Loop continues → next API call with tool results
    }

    // 6. Persist session
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
      toolCalls,
      compacted,
    };

    // Event log: query_end
    await appendEvent({ ...makeBase(), type: 'query_end', result });

    this._lastSessionId = session.id;
    emit({ type: 'query_end', result });
    return result;
  }

  // ===== Public API =====

  /** Get a session by ID */
  async getSession(id: string): Promise<Session | null> {
    return this.sessionStore.load(id);
  }

  /** List all session IDs */
  async listSessions(): Promise<string[]> {
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
    return [...this.tools.values()].map(t => t.definition);
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
  } {
    return {
      provider: this.currentProvider,
      systemPrompt: [...this.systemPrompt],
      tools: this.getTools(),
      skills: this.getSkillMetas(),
      cwd: this.cwd,
      middleware: this.middleware.length,
      hasToolGuard: !!this.toolGuard,
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

    // Resolve tools
    let delegateTools: ToolRegistration[];
    if (config?.allowedTools) {
      delegateTools = this.resolveAllowedTools(config.allowedTools);
    } else {
      delegateTools = [...this.tools.values()];
    }
    if (config?.additionalTools) {
      delegateTools = [...delegateTools, ...config.additionalTools];
    }

    // Create a transient provider (same instance for cache sharing, or new for model override)
    const delegateProvider = config?.model
      ? createProvider({ ...this.providerConfig, model: config.model })
      : this.provider;

    const delegateGuard = config?.toolGuard ?? this.toolGuard;

    // Build messages: context prefix + delegate prompt
    const messages: Message[] = [
      ...contextMessages,
      { role: 'user' as const, content: message, createdAt: Date.now() },
    ];

    // Run the delegate's tool loop
    let turns = 0;
    const maxTurns = config?.maxTurns ?? DEFAULT_MAX_TURNS;
    let totalUsage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
    let toolCalls = 0;
    const toolMap = new Map(delegateTools.map(t => [t.definition.name, t]));

    while (turns < maxTurns) {
      turns++;

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
    const result: DelegateResult = { text, usage: totalUsage, turns, toolCalls };
    emit({ type: 'delegate_end', result });
    return result;
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
      const session = await this.sessionStore.load(options.resume);
      if (!session) throw new Error(`Session not found: ${options.resume}`);
      // Allow overriding system prompt on resume
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
      metadata: {
        cwd: this.cwd,
        model: this.providerConfig.model,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCacheReadTokens: 0,
        totalCacheWriteTokens: 0,
        compactionCount: 0,
      },
    };
  }

  private resolveAllowedTools(allowed?: string[]): ToolRegistration[] {
    if (!allowed) return [...this.tools.values()];
    return allowed
      .map(name => this.tools.get(name))
      .filter((t): t is ToolRegistration => t !== undefined);
  }

  private async buildSystemPrompt(basePrompt: string[], override?: string | string[]): Promise<string[]> {
    if (override) return normalizeSystemPrompt(override);

    const base = [...basePrompt];

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

  /**
   * Decide whether to compact before the next API call.
   *
   * Strategy (same as CC):
   * - If we have real `inputTokens` from the last API response, use that.
   *   It tells us exactly how big the context was on the previous call.
   * - Otherwise (first turn, no prior call), fall back to char-based estimate.
   */
  private shouldCompact(session: Session): boolean {
    const contextWindow = this.compactionConfig?.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
    const threshold = this.compactionConfig?.threshold ?? Math.floor(contextWindow * DEFAULT_COMPACTION_RATIO);

    // Prefer real usage from last API response.
    // Total context = input_tokens + cache_read + cache_creation
    // (same as CC's calculateContextPercentages)
    const lastInput = session.metadata.lastInputTokens;
    if (lastInput !== undefined && lastInput > 0) {
      return lastInput > threshold;
    }

    // Fallback: rough estimate
    const estimated = estimateTokens(session.messages) + estimateTokens_system(session.systemPrompt);
    return estimated > threshold;
  }

  private async callProvider(
    request: ProviderRequest,
    stream: boolean,
    emit: (event: AgentEvent) => void,
  ): Promise<import('./types.js').ProviderResponse> {
    if (stream && this.provider.stream) {
      let finalResponse: import('./types.js').ProviderResponse | null = null;

      for await (const event of this.provider.stream(request)) {
        if (event.type === 'text_delta') {
          emit({ type: 'text_delta', text: event.text });
        } else if (event.type === 'thinking_delta') {
          emit({ type: 'thinking_delta', thinking: event.thinking });
        } else if (event.type === 'response') {
          finalResponse = event.response;
        }
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

function estimateTokens_system(blocks: string[]): number {
  return blocks.reduce((sum, b) => sum + Math.ceil(b.length / 4), 0);
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
