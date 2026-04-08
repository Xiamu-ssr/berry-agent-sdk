// ============================================================
// Agentic SDK — Agent Core
// ============================================================
// The main Agent class. Manages the agent loop, tools, sessions,
// compaction, and cache strategy. No CLI dependency — pure library.

import type {
  AgentConfig,
  QueryOptions,
  QueryResult,
  Message,
  Provider,
  ToolRegistration,
  Session,
  SessionStore,
  ContentBlock,
  ToolUseContent,
  TokenUsage,
} from './types.js';

export class Agent {
  private provider: Provider;
  private systemPrompt: string;
  private tools: Map<string, ToolRegistration>;
  private skills: string[];
  private cwd: string;
  private sessionStore: SessionStore;
  private compactionConfig: AgentConfig['compaction'];

  // Current session state
  private currentSession: Session | null = null;

  constructor(config: AgentConfig) {
    this.systemPrompt = config.systemPrompt;
    this.tools = new Map();
    this.skills = config.skills ?? [];
    this.cwd = config.cwd ?? process.cwd();
    this.compactionConfig = config.compaction;
    this.sessionStore = config.sessionStore ?? createInMemoryStore();

    // Register tools
    for (const tool of config.tools ?? []) {
      this.tools.set(tool.definition.name, tool);
    }

    // Provider will be initialized by factory (TODO)
    this.provider = null as any; // placeholder
  }

  /**
   * Send a message to the agent and get a response.
   * Automatically handles: tool calling loop, compaction, cache, session.
   */
  async query(prompt: string, options?: QueryOptions): Promise<QueryResult> {
    // 1. Resolve session
    const session = await this.resolveSession(options);
    this.currentSession = session;

    // 2. Add user message
    session.messages.push({
      role: 'user',
      content: prompt,
      createdAt: Date.now(),
    });

    // 3. Build allowed tools for this query
    const allowedTools = this.resolveAllowedTools(options?.allowedTools);

    // 4. Agent loop (ReAct)
    let turns = 0;
    const maxTurns = options?.maxTurns ?? 25;
    let totalUsage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
    let compacted = false;
    let toolCalls = 0;

    while (turns < maxTurns) {
      turns++;

      // 4a. Check compaction need BEFORE calling API
      if (this.shouldCompact(session)) {
        await this.compact(session);
        compacted = true;
      }

      // 4b. Build system prompt (static + dynamic skills)
      const fullSystemPrompt = await this.buildSystemPrompt(options?.systemPrompt);

      // 4c. Build cache breakpoints
      const cacheBreakpoints = this.provider.type === 'anthropic'
        ? this.computeCacheBreakpoints(fullSystemPrompt, session.messages)
        : []; // OpenAI: automatic, no breakpoints needed

      // 4d. Call provider
      const response = await this.provider.chat({
        systemPrompt: fullSystemPrompt,
        messages: session.messages,
        tools: allowedTools.map(t => t.definition),
        cacheBreakpoints,
      });

      // 4e. Accumulate usage
      totalUsage.inputTokens += response.usage.inputTokens;
      totalUsage.outputTokens += response.usage.outputTokens;
      totalUsage.cacheReadTokens = (totalUsage.cacheReadTokens ?? 0) + (response.usage.cacheReadTokens ?? 0);
      totalUsage.cacheWriteTokens = (totalUsage.cacheWriteTokens ?? 0) + (response.usage.cacheWriteTokens ?? 0);

      // 4f. Add assistant message
      session.messages.push({
        role: 'assistant',
        content: response.content,
        createdAt: Date.now(),
      });

      // 4g. If no tool calls, we're done
      if (response.stopReason !== 'tool_use') {
        break;
      }

      // 4h. Execute tool calls
      const toolUses = (response.content as ContentBlock[]).filter(
        (b): b is ToolUseContent => b.type === 'tool_use'
      );

      for (const toolUse of toolUses) {
        toolCalls++;
        const tool = this.tools.get(toolUse.name);
        if (!tool) {
          session.messages.push({
            role: 'user', // tool results go as user messages in Anthropic format
            content: [{
              type: 'tool_result',
              toolUseId: toolUse.id,
              content: `Error: unknown tool "${toolUse.name}"`,
              isError: true,
            }],
          });
          continue;
        }

        try {
          const result = await tool.execute(toolUse.input, {
            cwd: this.cwd,
            abortSignal: options?.abortSignal,
          });
          session.messages.push({
            role: 'user',
            content: [{
              type: 'tool_result',
              toolUseId: toolUse.id,
              content: result.forLLM ?? result.content,
            }],
          });
        } catch (err) {
          session.messages.push({
            role: 'user',
            content: [{
              type: 'tool_result',
              toolUseId: toolUse.id,
              content: `Error: ${err instanceof Error ? err.message : String(err)}`,
              isError: true,
            }],
          });
        }
      }

      // Loop continues → next API call with tool results
    }

    // 5. Save session
    session.lastAccessedAt = Date.now();
    await this.sessionStore.save(session);

    // 6. Extract final text
    const lastMessage = session.messages[session.messages.length - 1];
    const text = this.extractText(lastMessage);

    return {
      text,
      sessionId: session.id,
      usage: totalUsage,
      totalUsage,
      toolCalls,
      compacted,
    };
  }

  // ----- Internal Methods -----

  private async resolveSession(options?: QueryOptions): Promise<Session> {
    if (options?.resume) {
      const session = await this.sessionStore.load(options.resume);
      if (!session) throw new Error(`Session not found: ${options.resume}`);
      return session;
    }
    if (options?.fork) {
      const source = await this.sessionStore.load(options.fork);
      if (!source) throw new Error(`Session not found: ${options.fork}`);
      return {
        ...source,
        id: generateId(),
        messages: [...source.messages], // shallow copy
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
        model: '', // set by provider
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

  private async buildSystemPrompt(override?: string): Promise<string> {
    const base = override ?? this.systemPrompt;
    // TODO: load and inject skill files from this.skills
    // TODO: separate into static (cacheable) and dynamic parts
    return base;
  }

  private computeCacheBreakpoints(systemPrompt: string, messages: Message[]) {
    // TODO: implement Anthropic-specific cache breakpoint strategy
    // Key insight: place breakpoints at stable boundaries
    // - breakpoint 1: end of static system prompt
    // - breakpoint 2: end of dynamic system prompt (skills)
    // - breakpoint 3: end of stable conversation history
    // - breakpoint 4: auto-moves to latest message
    return [];
  }

  private shouldCompact(session: Session): boolean {
    // TODO: estimate token count of session.messages
    // Trigger at threshold (default 85% of context window)
    return false;
  }

  private async compact(session: Session): Promise<void> {
    // TODO: implement 7-layer compaction pipeline
    // See compaction/compactor.ts
  }

  private extractText(message: Message): string {
    if (typeof message.content === 'string') return message.content;
    const textBlocks = message.content.filter(b => b.type === 'text');
    return textBlocks.map(b => (b as any).text).join('\n');
  }
}

// ----- Helpers -----

function generateId(): string {
  return `ses_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function createInMemoryStore() {
  const sessions = new Map<string, any>();
  return {
    save: async (s: any) => { sessions.set(s.id, structuredClone(s)); },
    load: async (id: string) => sessions.get(id) ?? null,
    list: async () => [...sessions.keys()],
    delete: async (id: string) => { sessions.delete(id); },
  };
}
