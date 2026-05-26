import { createHash } from 'node:crypto';

import type { SystemPromptBlock, SystemPromptInput } from '@berry-agent/small-shared-core';
import type {
  ContentBlock,
  Message,
  ToolUseContent,
} from '../content-types.js';
import type { Session } from '../session-types.js';
import type {
  AgentEvent,
  AgentStatus,
  Middleware,
  MiddlewareContext,
  QueryOptions,
  QueryResult,
} from '../agent-runtime-types.js';
import type {
  ProviderConfig,
  ProviderRequest,
  ProviderResponse,
  TokenUsage,
} from '../provider-types.js';
import type {
  ToolGuard,
  ToolRegistration,
} from '../tool-types.js';
import type { EventLogStore, SessionEvent } from '../event-log/types.js';
import type { AgentCompactionCoordinator } from './compaction-coordinator.js';
import { DEFAULT_MAX_TURNS, MAX_PTL_RETRIES } from '../constants.js';
import { executeTools } from './tool-executor.js';
import {
  accumulateUsage,
  extractText,
} from './messages.js';
import { isPromptTooLongError } from './provider.js';
import {
  applyBeforeApiCall,
  notifyAfterApiCall,
  notifyApiCallError,
} from './middleware.js';
import { generateEventId } from './ids.js';

export interface AgentQueryLoopDeps {
  getSystemPrompt(): SystemPromptBlock[];
  getPromptPackVersion(): string;
  resolveAllowedTools(allowed?: string[], session?: Session): ToolRegistration[];
  buildSystemPrompt(base: readonly SystemPromptBlock[], override?: SystemPromptInput): Promise<SystemPromptBlock[]>;
  compactionCoordinator: AgentCompactionCoordinator;
  drainInterjects(): Message[];
  persistAndReadProviderMessages(session: Session): Promise<Message[]>;
  getProviderConfig(): ProviderConfig;
  callProvider(
    request: ProviderRequest,
    stream: boolean,
    emit: (event: AgentEvent) => void,
  ): Promise<ProviderResponse>;
  getMiddleware(): readonly Middleware[];
  getMiddlewareContext(session: Session): MiddlewareContext;
  toolGuard?: ToolGuard;
  cwd: string;
  saveSession(session: Session): Promise<void>;
  setStatus(status: AgentStatus, detail?: string): void;
  setLastSessionId(sessionId: string): void;
}

export interface AgentQueryLoopParams {
  session: Session;
  prompt: string | ContentBlock[];
  options?: QueryOptions;
  emit(event: AgentEvent): void;
  appendEvent(event: SessionEvent): Promise<void>;
  makeBase(): { id: string; timestamp: number; sessionId: string; turnId?: string };
  log?: EventLogStore;
}

/**
 * Execute one managed-agent turn: provider request, prompt-too-long recovery,
 * tool loop, usage accounting, event-log checkpoints, and final QueryResult.
 *
 * The Agent class owns lifecycle and mutable state; this helper owns the turn
 * algorithm so the SDK has one audited harness path instead of inline loops.
 */
export async function runAgentQueryLoop(
  deps: AgentQueryLoopDeps,
  params: AgentQueryLoopParams,
): Promise<QueryResult> {
  const {
    session,
    options,
    emit,
    appendEvent,
    makeBase,
    log,
  } = params;

  const allowedTools = deps.resolveAllowedTools(options?.allowedTools, session);
  const fullSystemPrompt = await deps.buildSystemPrompt(deps.getSystemPrompt(), options?.systemPrompt);
  let compacted = false;
  const compactionRequest = {
    session,
    decisionSystemPrompt: deps.getSystemPrompt(),
    providerSystemPrompt: fullSystemPrompt,
    allowedTools,
    emit,
    appendEvent,
    makeBase,
  };
  compacted = await deps.compactionCoordinator.maybeCompactAtTurnStart(compactionRequest) || compacted;

  let turns = 0;
  const maxTurns = options?.maxTurns ?? DEFAULT_MAX_TURNS;
  let totalUsage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
  let toolCallCount = 0;

  while (turns < maxTurns) {
    turns++;

    compacted = await deps.compactionCoordinator.maybeCompactBeforeInference(compactionRequest) || compacted;
    deps.setStatus('tool_use', 'thinking');

    const interjects = deps.drainInterjects();
    if (interjects.length > 0) {
      session.messages.push(...interjects);
      for (const msg of interjects) {
        const text = typeof msg.content === 'string' ? msg.content : '';
        await appendEvent({ ...makeBase(), type: 'user_message', content: text });
      }
    }

    let messagesForProvider = await deps.persistAndReadProviderMessages(session);
    const providerConfig = deps.getProviderConfig();

    emit({
      type: 'api_call',
      messages: messagesForProvider.length,
      tools: allowedTools.length,
    });

    const requestId = generateEventId();
    await appendEvent({
      ...makeBase(),
      type: 'api_request',
      requestId,
      model: providerConfig.model,
      messages: messagesForProvider,
      tools: allowedTools.map(t => ({ name: t.definition.name, description: t.definition.description })),
      params: { maxTokens: providerConfig.maxTokens, thinkingBudget: providerConfig.thinkingBudget },
      contextManifest: buildContextManifest(
        deps.getPromptPackVersion(),
        fullSystemPrompt,
        messagesForProvider,
        allowedTools,
      ),
    });

    const response = await callProviderWithPromptTooLongRecovery({
      deps,
      session,
      options,
      emit,
      compactionRequest,
      reloadMessages: async () => {
        messagesForProvider = await deps.persistAndReadProviderMessages(session);
      },
      getMessages: () => messagesForProvider,
      fullSystemPrompt,
      allowedTools,
      markCompacted: () => {
        compacted = true;
      },
    });
    const responseProviderConfig = deps.getProviderConfig();

    await appendEvent({
      ...makeBase(),
      type: 'api_response',
      requestId,
      model: responseProviderConfig.model,
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
      model: responseProviderConfig.model,
    });

    totalUsage = accumulateUsage(totalUsage, response.usage);
    updateUsageMetadata(session, response.usage);

    session.messages.push({
      role: 'assistant',
      content: response.content,
      createdAt: Date.now(),
    });
    await appendEvent({ ...makeBase(), type: 'assistant_message', content: response.content });

    const toolUses = (response.content as ContentBlock[]).filter(
      (b): b is ToolUseContent => b.type === 'tool_use',
    );
    if (response.stopReason !== 'tool_use' && toolUses.length === 0) {
      break;
    }
    if (response.stopReason !== 'tool_use' && toolUses.length > 0) {
      response.stopReason = 'tool_use';
    }
    deps.setStatus('tool_use', toolUses.map(t => t.name).join(', '));

    const execResult = await executeTools({
      toolUses,
      tools: new Map(allowedTools.map(tool => [tool.definition.name, tool])),
      toolGuard: deps.toolGuard,
      middleware: deps.getMiddleware(),
      session,
      emit,
      appendEvent,
      makeBase,
      middlewareContext: deps.getMiddlewareContext(session),
      cwd: deps.cwd,
      model: responseProviderConfig.model,
      abortSignal: options?.abortSignal,
    });

    toolCallCount += execResult.toolCalls;
    deps.setStatus('tool_use', 'thinking');

    session.messages.push({
      role: 'user',
      content: execResult.results,
      createdAt: Date.now(),
    });

    session.lastAccessedAt = Date.now();
    await deps.saveSession(session);
  }

  session.lastAccessedAt = Date.now();
  await deps.saveSession(session);

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

  await appendEvent({ ...makeBase(), type: 'query_end', result });

  if (log) {
    await appendEvent({
      ...makeBase(),
      type: 'messages_snapshot',
      messages: session.messages,
      reason: 'turn_end',
    });
  }

  deps.setLastSessionId(session.id);
  emit({ type: 'query_end', result });
  return result;
}

async function callProviderWithPromptTooLongRecovery({
  deps,
  session,
  options,
  emit,
  compactionRequest,
  reloadMessages,
  getMessages,
  fullSystemPrompt,
  allowedTools,
  markCompacted,
}: {
  deps: AgentQueryLoopDeps;
  session: Session;
  options?: QueryOptions;
  emit(event: AgentEvent): void;
  compactionRequest: Parameters<AgentCompactionCoordinator['compactAfterPromptTooLong']>[0];
  reloadMessages(): Promise<void>;
  getMessages(): Message[];
  fullSystemPrompt: SystemPromptBlock[];
  allowedTools: ToolRegistration[];
  markCompacted(): void;
}): Promise<ProviderResponse> {
  let ptlRetries = 0;

  while (true) {
    let providerRequest: ProviderRequest = {
      systemPrompt: fullSystemPrompt,
      messages: getMessages(),
      tools: allowedTools.map(t => t.definition),
      signal: options?.abortSignal,
      responseFormat: options?.responseFormat,
    };
    const middlewareContext = deps.getMiddlewareContext(session);

    try {
      providerRequest = await applyBeforeApiCall(providerRequest, deps.getMiddleware(), middlewareContext);
      const response = await deps.callProvider(providerRequest, options?.stream === true, emit);
      await notifyAfterApiCall(providerRequest, response, deps.getMiddleware(), middlewareContext);
      return response;
    } catch (err) {
      if (isPromptTooLongError(err) && ptlRetries < MAX_PTL_RETRIES) {
        ptlRetries++;
        await deps.compactionCoordinator.compactAfterPromptTooLong(compactionRequest, err);
        markCompacted();
        await reloadMessages();
        continue;
      }
      await notifyApiCallError(providerRequest, err, deps.getMiddleware(), middlewareContext);
      throw err;
    }
  }
}

function updateUsageMetadata(session: Session, usage: TokenUsage): void {
  session.metadata.totalInputTokens += usage.inputTokens;
  session.metadata.totalOutputTokens += usage.outputTokens;
  session.metadata.totalCacheReadTokens += usage.cacheReadTokens ?? 0;
  session.metadata.totalCacheWriteTokens += usage.cacheWriteTokens ?? 0;

  if (usage.inputTokens > 0) {
    session.metadata.lastInputTokens = usage.inputTokens;
  }
}

function buildContextManifest(
  promptPackVersion: string,
  systemPrompt: readonly SystemPromptBlock[],
  messages: readonly Message[],
  allowedTools: readonly ToolRegistration[],
): import('../event-log/types.js').ContextManifest {
  return {
    promptPackVersion,
    messageSource: 'messages.json',
    messageCount: messages.length,
    systemBlockCount: systemPrompt.length,
    systemBlockHashes: systemPrompt.map((block) => shortHash(block.text)),
    toolCount: allowedTools.length,
    toolsHash: shortHash(allowedTools.map((tool) => tool.definition)),
  };
}

function shortHash(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return createHash('sha256').update(text ?? '').digest('hex').slice(0, 16);
}
