// ============================================================
// Berry Agent SDK — Agent Core
// ============================================================
// The main Agent class. Pure library, no CLI dependency.
// Manages: agent loop, tools, sessions, compaction, cache.

import type {
  AgentConfig,
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
} from './types.js';
import { AnthropicProvider } from './providers/anthropic.js';
import { OpenAIProvider } from './providers/openai.js';
import { compact, estimateTokens } from './compaction/compactor.js';
import {
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_COMPACTION_RATIO,
  DEFAULT_MAX_TURNS,
} from './constants.js';

export class Agent {
  private provider: Provider;
  private providerConfig: ProviderConfig;
  private systemPrompt: string[];
  private tools: Map<string, ToolRegistration>;
  private skills: string[];
  private cwd: string;
  private sessionStore: SessionStore;
  private compactionConfig: AgentConfig['compaction'];
  private onEvent?: (event: AgentEvent) => void;

  constructor(config: AgentConfig) {
    // Normalize system prompt to array of blocks
    this.systemPrompt = Array.isArray(config.systemPrompt)
      ? config.systemPrompt
      : [config.systemPrompt];

    this.tools = new Map();
    this.skills = config.skills ?? [];
    this.cwd = config.cwd ?? process.cwd();
    this.compactionConfig = config.compaction;
    this.sessionStore = config.sessionStore ?? createInMemoryStore();
    this.onEvent = config.onEvent;
    this.providerConfig = config.provider;

    // Register tools
    for (const tool of config.tools ?? []) {
      this.tools.set(tool.definition.name, tool);
    }

    // Create provider
    this.provider = config.providerInstance ?? createProvider(config.provider);
  }

  /**
   * Send a message to the agent and get a response.
   * Handles: tool loop, compaction, cache, session persistence.
   */
  async query(prompt: string, options?: QueryOptions): Promise<QueryResult> {
    // 1. Resolve session (new / resume / fork)
    const session = await this.resolveSession(options);
    const emit = (event: AgentEvent) => this.emit(event, options?.onEvent);

    emit({ type: 'query_start', prompt, sessionId: session.id });

    // 2. Add user message
    session.messages.push({
      role: 'user',
      content: prompt,
      createdAt: Date.now(),
    });

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
        const result = await compact(
          session.messages,
          {
            contextWindow: this.compactionConfig?.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
            threshold: this.compactionConfig?.threshold,
            enabledLayers: this.compactionConfig?.enabledLayers,
          },
          this.provider,
        );
        session.messages = result.messages;
        session.metadata.compactionCount++;
        compacted = true;

        emit({
          type: 'compaction',
          layersApplied: result.layersApplied,
          tokensFreed: result.tokensFreed,
        });
      }

      // 5b. Call provider
      emit({
        type: 'api_call',
        messages: session.messages.length,
        tools: allowedTools.length,
      });

      const providerRequest: ProviderRequest = {
        systemPrompt: fullSystemPrompt,
        messages: session.messages,
        tools: allowedTools.map(t => t.definition),
        signal: options?.abortSignal,
      };

      const response = await this.callProvider(providerRequest, options?.stream === true, emit);

      emit({
        type: 'api_response',
        usage: response.usage,
        stopReason: response.stopReason,
      });

      // 5c. Accumulate usage
      totalUsage = accumulateUsage(totalUsage, response.usage);
      session.metadata.totalInputTokens += response.usage.inputTokens;
      session.metadata.totalOutputTokens += response.usage.outputTokens;
      session.metadata.totalCacheReadTokens += response.usage.cacheReadTokens ?? 0;
      session.metadata.totalCacheWriteTokens += response.usage.cacheWriteTokens ?? 0;

      // Track last known input tokens for compaction decisions
      session.metadata.lastInputTokens = response.usage.inputTokens;

      // 5d. Add assistant message to session
      session.messages.push({
        role: 'assistant',
        content: response.content,
        createdAt: Date.now(),
      });

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
      const toolResultBlocks: ContentBlock[] = [];

      for (const toolUse of toolUses) {
        toolCalls++;
        emit({ type: 'tool_call', name: toolUse.name, input: toolUse.input });

        const tool = this.tools.get(toolUse.name);
        if (!tool) {
          toolResultBlocks.push({
            type: 'tool_result',
            toolUseId: toolUse.id,
            content: `Error: unknown tool "${toolUse.name}"`,
            isError: true,
          });
          emit({ type: 'tool_result', name: toolUse.name, isError: true });
          continue;
        }

        try {
          const result = await tool.execute(toolUse.input, {
            cwd: this.cwd,
            abortSignal: options?.abortSignal,
          });
          toolResultBlocks.push({
            type: 'tool_result',
            toolUseId: toolUse.id,
            content: result.forLLM ?? result.content,
            isError: result.isError,
          });
          emit({ type: 'tool_result', name: toolUse.name, isError: result.isError ?? false });
        } catch (err) {
          toolResultBlocks.push({
            type: 'tool_result',
            toolUseId: toolUse.id,
            content: `Error: ${err instanceof Error ? err.message : String(err)}`,
            isError: true,
          });
          emit({ type: 'tool_result', name: toolUse.name, isError: true });
        }
      }

      // Add all tool results as one user message
      session.messages.push({
        role: 'user',
        content: toolResultBlocks,
        createdAt: Date.now(),
      });

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

  /** Remove a tool at runtime */
  removeTool(name: string): boolean {
    return this.tools.delete(name);
  }

  // ===== Internal Methods =====

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

    // Load skill files if configured
    if (this.skills.length > 0) {
      const skillContent = await this.loadSkills();
      if (skillContent) {
        base.push(skillContent);
      }
    }

    return base;
  }

  private async loadSkills(): Promise<string | null> {
    // Read skill .md files and concatenate
    const { readFile } = await import('node:fs/promises');
    const parts: string[] = [];
    for (const path of this.skills) {
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

    // Prefer real usage from last API response
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
