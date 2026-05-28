// ============================================================
// Agent delegate — one-shot forked execution with cache sharing
// ============================================================
// Extracted from agent.ts. The delegate path has its own small tool
// loop that deliberately bypasses compaction, event log, memory, and
// crash recovery — it's a transient forked turn that inherits the
// parent's conversation prefix as a cache hit and throws away its
// own result after returning.
//
// Kept as pure functions taking an explicit dependency bag, so the
// Agent class can stay a thin facade over the big branches of logic.

import type { SystemPromptBlock, SystemPromptInput } from '@berry-agent/small-shared-core';
import { normalizeSystemPrompt } from '@berry-agent/small-shared-core';
import type {
  AgentEvent,
  AgentStatus,
  DelegateConfig,
  DelegateResult,
  Middleware,
  MiddlewareContext,
  QueryOptions,
} from '../agent-runtime-types.js';
import type { ContentBlock, Message, ToolUseContent } from '../content-types.js';
import type {
  Provider,
  ProviderConfig,
  ProviderRequest,
  ProviderResponse,
  TokenUsage,
} from '../provider-types.js';
import type { Session, SessionStore } from '../session-types.js';
import type { ToolGuard, ToolRegistration } from '../tool-types.js';
import { DEFAULT_MAX_TURNS } from '../constants.js';
import { TOOL_DELEGATE } from '../tool-names.js';
import {
  extractText,
  accumulateUsage,
  mergeToolsByName,
} from './messages.js';
import { createEmptySessionMetadata } from './session.js';
import { createProvider } from './provider.js';
import {
  applyBeforeApiCall,
  notifyAfterApiCall,
  notifyApiCallError,
} from './middleware.js';
import { executeTools } from './tool-executor.js';

/**
 * Dependencies delegate() reaches into on the Agent. Keeps the extraction
 * typed without needing the whole Agent class here.
 */
export interface DelegateDeps {
  readonly status: AgentStatus;
  readonly lastSessionId: string | undefined;
  readonly sessionStore: SessionStore;
  readonly providerConfig: ProviderConfig;
  readonly provider: Provider;
  readonly toolGuard?: ToolGuard;
  readonly middleware: readonly Middleware[];
  readonly cwd: string;
  readonly onEvent?: (event: AgentEvent) => void;
  readonly systemPrompt: readonly SystemPromptBlock[];

  /** Transition the agent's status (and emit the status_change event). */
  setStatus(status: AgentStatus, detail?: string): void;

  /** Build the static + dynamic system prompt (with skill index, AGENTS.md, etc.). */
  buildSystemPrompt(
    basePrompt: readonly SystemPromptBlock[],
    override?: SystemPromptInput,
  ): Promise<SystemPromptBlock[]>;

  /** Resolve the tool list for a specific query (honoring allow-lists). */
  resolveAllowedTools(allowed?: string[], session?: Session): ToolRegistration[];
}

/**
 * Execute a one-shot delegate against the given dependency bag. This is the
 * body of {@link Agent.delegate}; see that method's doc comment for semantics.
 */
export async function runDelegate(
  deps: DelegateDeps,
  message: string,
  config: DelegateConfig | undefined,
): Promise<DelegateResult> {
  if (deps.status === 'disposed') {
    throw new Error('Agent has been disposed; create a new instance to continue');
  }

  const previousStatus = deps.status;
  deps.setStatus('tool_use', 'delegating');
  const emit = (event: AgentEvent): void => {
    deps.onEvent?.(event);
    config?.onEvent?.(event);
  };

  // Stable sessionId for the entire delegate lifecycle (fixes FK + observe consistency).
  const delegateSessionId = `delegate_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  emit({ type: 'query_start', sessionId: delegateSessionId, prompt: message });
  emit({ type: 'delegate_start', message });

  // Build system prompt for the delegate.
  let delegateSystemPrompt: SystemPromptBlock[];
  if (config?.overrideSystemPrompt !== undefined) {
    delegateSystemPrompt = normalizeSystemPrompt(config.overrideSystemPrompt);
  } else {
    // Start with main agent's system prompt (cache sharing).
    delegateSystemPrompt = await deps.buildSystemPrompt(deps.systemPrompt);
    if (config?.appendSystemPrompt !== undefined) {
      const extra = normalizeSystemPrompt(config.appendSystemPrompt);
      delegateSystemPrompt = [...delegateSystemPrompt, ...extra];
    }
  }

  // Build conversation prefix (main agent's messages for cache sharing).
  let contextMessages: Message[] = [];
  if (config?.includeHistory !== false) {
    const sid = config?.sessionId ?? deps.lastSessionId;
    if (sid) {
      const session = await deps.sessionStore.load(sid);
      if (session) contextMessages = [...session.messages];
    }
  }

  const messages: Message[] = [
    ...contextMessages,
    { role: 'user' as const, content: message, createdAt: Date.now() },
  ];

  const delegateSession: Session = {
    id: delegateSessionId,
    messages,
    createdAt: Date.now(),
    lastAccessedAt: Date.now(),
    metadata: createEmptySessionMetadata(),
  };

  // Resolve tools.
  let delegateTools = deps.resolveAllowedTools(config?.allowedTools, delegateSession);
  if (config?.additionalTools) {
    delegateTools = mergeToolsByName(config.additionalTools, delegateTools);
  }
  // A delegate is already the forked worker; do not let it recursively spawn
  // another delegate through the inherited built-in tool.
  delegateTools = delegateTools.filter((tool) => tool.definition.name !== TOOL_DELEGATE);

  // Transient provider — same instance for cache sharing, or fresh for model override.
  const delegateProvider = config?.model
    ? createProvider({ ...deps.providerConfig, model: config.model })
    : deps.provider;

  const delegateGuard = config?.toolGuard ?? deps.toolGuard;

  let delegateTurns = 0;
  const maxTurns = config?.maxTurns ?? DEFAULT_MAX_TURNS;
  let totalUsage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
  let toolCalls = 0;
  const toolMap = new Map(delegateTools.map((t) => [t.definition.name, t]));

  try {
    while (delegateTurns < maxTurns) {
      delegateTurns++;

      let request: ProviderRequest = {
        systemPrompt: delegateSystemPrompt,
        messages,
        tools: delegateTools.map((t) => t.definition),
        signal: config?.abortSignal,
      };

      // Reuse stable delegateSessionId across all turns.
      const mwCtx: MiddlewareContext = {
        sessionId: delegateSessionId,
        model: config?.model ?? deps.providerConfig.model,
        provider: deps.providerConfig.type,
        cwd: deps.cwd,
      };
      request = await applyBeforeApiCall(request, deps.middleware, mwCtx);

      let response: ProviderResponse;
      try {
        response =
          config?.stream && delegateProvider.stream
            ? await streamProvider(delegateProvider, request, emit)
            : await delegateProvider.chat(request);
        await notifyAfterApiCall(request, response, deps.middleware, mwCtx);
      } catch (err) {
        await notifyApiCallError(request, err, deps.middleware, mwCtx);
        throw err;
      }

      totalUsage = accumulateUsage(totalUsage, response.usage);
      emit({
        type: 'api_response',
        usage: response.usage,
        stopReason: response.stopReason,
        model: config?.model ?? deps.providerConfig.model,
      });

      messages.push({ role: 'assistant', content: response.content, createdAt: Date.now() });

      // DEFENSIVE: check content for tool_use blocks, not just stopReason.
      // See main loop comment for rationale — streaming can drop stop_reason.
      const toolUses = (response.content as ContentBlock[]).filter(
        (b): b is ToolUseContent => b.type === 'tool_use',
      );
      if (response.stopReason !== 'tool_use' && toolUses.length === 0) break;
      if (response.stopReason !== 'tool_use' && toolUses.length > 0) {
        response.stopReason = 'tool_use';
      }
      const execResult = await executeTools({
        toolUses,
        tools: toolMap,
        toolGuard: delegateGuard,
        middleware: deps.middleware,
        session: delegateSession,
        emit,
        appendEvent: async () => {},
        makeBase: () => ({
          id: `delegate_evt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          timestamp: Date.now(),
          sessionId: delegateSessionId,
        }),
        middlewareContext: mwCtx,
        cwd: deps.cwd,
        model: mwCtx.model,
        abortSignal: config?.abortSignal,
      });

      toolCalls += execResult.toolCalls;
      messages.push({ role: 'user', content: execResult.results, createdAt: Date.now() });
    }

    const lastMsg = messages[messages.length - 1]!;
    const text = extractText(lastMsg);
    const result: DelegateResult = { text, usage: totalUsage, turns: delegateTurns, toolCalls };
    emit({ type: 'delegate_end', result });
    return result;
  } finally {
    deps.setStatus(previousStatus);
  }
}

/** Stream a provider request, routing text/thinking deltas through `emit`. */
async function streamProvider(
  provider: Provider,
  request: ProviderRequest,
  emit: (event: AgentEvent) => void,
): Promise<ProviderResponse> {
  if (!provider.stream) return provider.chat(request);
  let finalResponse: ProviderResponse | null = null;
  for await (const event of provider.stream(request)) {
    if (event.type === 'text_delta') emit({ type: 'text_delta', text: event.text });
    else if (event.type === 'thinking_delta') emit({ type: 'thinking_delta', thinking: event.thinking });
    else if (event.type === 'response') finalResponse = event.response;
  }
  if (!finalResponse) throw new Error('Provider stream ended without a final response');
  return finalResponse;
}

/** Re-export so callers needing the same signature don't re-duplicate. */
export { streamProvider as delegateStreamProvider };

// Convenience — QueryOptions is pulled in by consumers that also use delegate.
export type { QueryOptions };
