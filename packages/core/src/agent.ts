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
  ToolRegistration,
  Session,
  SessionStore,
  ContentBlock,
  ToolUseContent,
  TokenUsage,
  AgentEvent,
} from './types.js';
import { AnthropicProvider } from './providers/anthropic.js';
import { compact } from './compaction/compactor.js';

export class Agent {
  private provider: Provider;
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

    // Register tools
    for (const tool of config.tools ?? []) {
      this.tools.set(tool.definition.name, tool);
    }

    // Create provider
    this.provider = createProvider(config.provider);
  }

  /**
   * Send a message to the agent and get a response.
   * Handles: tool loop, compaction, cache, session persistence.
   */
  async query(prompt: string, options?: QueryOptions): Promise<QueryResult> {
    // 1. Resolve session (new / resume / fork)
    const session = await this.resolveSession(options);

    this.emit({ type: 'query_start', prompt, sessionId: session.id });

    // 2. Add user message
    session.messages.push({
      role: 'user',
      content: prompt,
      createdAt: Date.now(),
    });

    // 3. Resolve tools for this query
    const allowedTools = this.resolveAllowedTools(options?.allowedTools);

    // 4. Build system prompt (static blocks + dynamic skills)
    const fullSystemPrompt = await this.buildSystemPrompt(options?.systemPrompt);

    // 5. Agent loop (tool calling)
    let turns = 0;
    const maxTurns = options?.maxTurns ?? 25;
    let totalUsage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
    let compacted = false;
    let toolCalls = 0;

    while (turns < maxTurns) {
      turns++;

      // 5a. Check compaction BEFORE API call
      if (this.shouldCompact(session)) {
        const result = await compact(
          session.messages,
          {
            contextWindow: this.compactionConfig?.contextWindow ?? 200_000,
            threshold: this.compactionConfig?.threshold,
            enabledLayers: this.compactionConfig?.enabledLayers,
          },
          this.provider,
        );
        session.messages = result.messages;
        session.metadata.compactionCount++;
        compacted = true;

        this.emit({
          type: 'compaction',
          layersApplied: result.layersApplied,
          tokensFreed: result.tokensFreed,
        });
      }

      // 5b. Call provider
      this.emit({
        type: 'api_call',
        messages: session.messages.length,
        tools: allowedTools.length,
      });

      const response = await this.provider.chat({
        systemPrompt: fullSystemPrompt,
        messages: session.messages,
        tools: allowedTools.map(t => t.definition),
        signal: options?.abortSignal,
      });

      this.emit({
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
        this.emit({ type: 'tool_call', name: toolUse.name, input: toolUse.input });

        const tool = this.tools.get(toolUse.name);
        if (!tool) {
          toolResultBlocks.push({
            type: 'tool_result',
            toolUseId: toolUse.id,
            content: `Error: unknown tool "${toolUse.name}"`,
            isError: true,
          });
          this.emit({ type: 'tool_result', name: toolUse.name, isError: true });
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
          });
          this.emit({ type: 'tool_result', name: toolUse.name, isError: false });
        } catch (err) {
          toolResultBlocks.push({
            type: 'tool_result',
            toolUseId: toolUse.id,
            content: `Error: ${err instanceof Error ? err.message : String(err)}`,
            isError: true,
          });
          this.emit({ type: 'tool_result', name: toolUse.name, isError: true });
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

    this.emit({ type: 'query_end', result });
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
        model: this.config.model,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCacheReadTokens: 0,
        totalCacheWriteTokens: 0,
        compactionCount: 0,
      },
    };
  }

  private get config(): ProviderConfig {
    return (this.provider as any).config;
  }

  private resolveAllowedTools(allowed?: string[]): ToolRegistration[] {
    if (!allowed) return [...this.tools.values()];
    return allowed
      .map(name => this.tools.get(name))
      .filter((t): t is ToolRegistration => t !== undefined);
  }

  private async buildSystemPrompt(override?: string | string[]): Promise<string[]> {
    if (override) return normalizeSystemPrompt(override);

    const base = [...this.systemPrompt];

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

  private shouldCompact(session: Session): boolean {
    const contextWindow = this.compactionConfig?.contextWindow ?? 200_000;
    const threshold = this.compactionConfig?.threshold ?? Math.floor(contextWindow * 0.85);
    const estimated = estimateTokens(session.messages) + estimateTokens_system(session.systemPrompt);
    return estimated > threshold;
  }

  private emit(event: AgentEvent): void {
    this.onEvent?.(event);
  }
}

// ===== Provider Factory =====

function createProvider(config: ProviderConfig): Provider {
  switch (config.type) {
    case 'anthropic':
      return new AnthropicProvider(config);
    case 'openai':
      // TODO: implement OpenAI provider
      throw new Error('OpenAI provider not yet implemented');
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
    .filter(b => b.type === 'text')
    .map(b => (b as any).text)
    .join('\n');
}

/** Rough token estimation: ~4 chars per token */
function estimateTokens(messages: Message[]): number {
  let total = 0;
  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      total += Math.ceil(msg.content.length / 4);
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if ('text' in block) total += Math.ceil(String((block as any).text).length / 4);
        if ('content' in block) total += Math.ceil(String((block as any).content).length / 4);
        if ('thinking' in block) total += Math.ceil(String((block as any).thinking).length / 4);
        if ('input' in block) total += Math.ceil(JSON.stringify((block as any).input).length / 4);
      }
    }
  }
  return total;
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
