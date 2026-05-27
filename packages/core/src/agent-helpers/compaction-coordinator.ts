import type { SystemPromptBlock } from '@berry-agent/small-shared-core';
import type {
  AgentEvent,
  CompactionContext,
  CompactionOutcome,
  Middleware,
  MiddlewareContext,
} from '../agent-runtime-types.js';
import type { CompactionConfig, CompactionStrategy } from '../compaction/types.js';
import type { Provider } from '../provider-types.js';
import type { Session } from '../session-types.js';
import type { ToolRegistration } from '../tool-types.js';
import type { SessionEvent } from '../event-log/types.js';
import type { AgentMemory } from '../workspace/types.js';
import type { PromptPack } from '../prompts.js';
import {
  COMPACTION_TRIGGER_REASON,
  DEFAULT_CONTEXT_WINDOW,
  type CompactionTriggerReason,
} from '../constants.js';
import {
  currentContextTokens,
  preCompactMemoryFlush,
  runCompaction,
  shouldHardCompact,
  shouldSoftCompact,
  type RunCompactionResult,
} from '../compaction/runner.js';
import { extractContextWindowFromError } from './provider.js';

export interface AgentCompactionCoordinatorDeps {
  compactionConfig: () => CompactionConfig | undefined;
  setCompactionConfig: (config: CompactionConfig | undefined) => void;
  compactionStrategy: () => CompactionStrategy | undefined;
  memory: () => AgentMemory | undefined;
  provider: () => Provider;
  promptPack: () => PromptPack;
  middleware: () => Middleware[];
  middlewareContext: (session: Session) => MiddlewareContext;
  setStatus: (status: 'tool_use', detail?: string) => void;
}

export interface AgentCompactionRequest {
  session: Session;
  decisionSystemPrompt: SystemPromptBlock[];
  providerSystemPrompt: SystemPromptBlock[];
  allowedTools: ToolRegistration[];
  emit: (event: AgentEvent) => void;
  appendEvent: (event: SessionEvent) => Promise<void>;
  makeBase: () => { id: string; timestamp: number; sessionId: string; turnId?: string };
}

export class AgentCompactionCoordinator {
  constructor(private readonly deps: AgentCompactionCoordinatorDeps) {}

  contextWindow(): number {
    return this.deps.compactionConfig()?.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
  }

  async maybeCompactAtTurnStart(request: AgentCompactionRequest): Promise<boolean> {
    const contextWindow = this.contextWindow();
    const params = {
      session: request.session,
      systemPrompt: request.decisionSystemPrompt,
      compactionConfig: this.deps.compactionConfig(),
      contextWindow,
    };
    if (!shouldSoftCompact(params)) return false;

    const compactLevel = shouldHardCompact(params) ? 'hard' : 'soft';
    await this.compact(request, {
      level: compactLevel,
      reason: 'threshold',
      tokensBefore: currentContextTokens({
        session: request.session,
        systemPrompt: request.providerSystemPrompt,
      }),
    });
    return true;
  }

  async maybeCompactBeforeInference(request: AgentCompactionRequest): Promise<boolean> {
    const contextWindow = this.contextWindow();
    const params = {
      session: request.session,
      systemPrompt: request.decisionSystemPrompt,
      compactionConfig: this.deps.compactionConfig(),
      contextWindow,
    };
    if (!shouldHardCompact(params)) return false;

    await this.compact(request, {
      level: 'hard',
      reason: 'threshold',
      tokensBefore: currentContextTokens({
        session: request.session,
        systemPrompt: request.providerSystemPrompt,
      }),
    });
    return true;
  }

  async compactAfterPromptTooLong(request: AgentCompactionRequest, error: unknown): Promise<void> {
    this.learnContextWindowFromError(error);
    await this.compact(request, {
      level: 'hard',
      reason: 'overflow_retry',
      tokensBefore: currentContextTokens({
        session: request.session,
        systemPrompt: request.providerSystemPrompt,
      }),
    }, COMPACTION_TRIGGER_REASON.OVERFLOW_RETRY);
  }

  private learnContextWindowFromError(error: unknown): void {
    const learnedContextWindow = extractContextWindowFromError(error);
    const current = this.contextWindow();
    if (!learnedContextWindow || learnedContextWindow <= 0 || learnedContextWindow >= current) return;
    this.deps.setCompactionConfig({
      ...this.deps.compactionConfig(),
      contextWindow: learnedContextWindow,
    });
  }

  private async compact(
    request: AgentCompactionRequest,
    compactCtx: CompactionContext,
    triggerOverride?: CompactionTriggerReason,
  ): Promise<RunCompactionResult> {
    const memory = this.deps.memory();
    if (compactCtx.level === 'hard' && compactCtx.reason === 'threshold' && memory) {
      this.deps.setStatus('tool_use', 'memory_flushing');
      await preCompactMemoryFlush({
        session: request.session,
        memory,
        provider: this.deps.provider(),
        systemPrompt: request.providerSystemPrompt,
        promptPack: this.deps.promptPack(),
        emit: request.emit,
        appendEvent: request.appendEvent,
        makeBase: request.makeBase,
      });
    }

    this.deps.setStatus(
      'tool_use',
      compactCtx.reason === 'overflow_retry'
        ? `compacting:${COMPACTION_TRIGGER_REASON.OVERFLOW_RETRY}`
        : `compacting:${compactCtx.level}`,
    );

    return this.runWithMiddleware(request.session, compactCtx, () => runCompaction({
      compactionStrategy: this.deps.compactionStrategy(),
      session: request.session,
      compactionConfig: this.deps.compactionConfig(),
      compactLevel: compactCtx.level,
      provider: this.deps.provider(),
      systemPrompt: request.providerSystemPrompt,
      promptPack: this.deps.promptPack(),
      allowedTools: request.allowedTools,
      emit: this.overrideCompactionEmit(request.emit, triggerOverride),
      appendEvent: this.overrideCompactionEvent(request.appendEvent, triggerOverride),
      makeBase: request.makeBase,
    }));
  }

  private async runWithMiddleware(
    session: Session,
    compactCtx: CompactionContext,
    run: () => Promise<RunCompactionResult>,
  ): Promise<RunCompactionResult> {
    const mwCtx = this.deps.middlewareContext(session);
    for (const mw of this.deps.middleware()) {
      if (mw.onBeforeCompact) {
        try { await mw.onBeforeCompact(compactCtx, mwCtx); } catch { /* observer errors must not abort compaction */ }
      }
    }
    const result = await run();
    const outcome: CompactionOutcome = {
      tokensFreed: result.result.tokensFreed,
      layersApplied: [...result.result.layersApplied],
      durationMs: result.durationMs,
    };
    for (const mw of this.deps.middleware()) {
      if (mw.onAfterCompact) {
        try { await mw.onAfterCompact(compactCtx, outcome, mwCtx); } catch { /* observer errors must not abort compaction */ }
      }
    }
    return result;
  }

  private overrideCompactionEmit(
    emit: (event: AgentEvent) => void,
    triggerOverride?: CompactionTriggerReason,
  ): (event: AgentEvent) => void {
    if (!triggerOverride) return emit;
    return (event) => {
      if (event.type === 'compaction') {
        emit({ ...event, triggerReason: triggerOverride });
        return;
      }
      emit(event);
    };
  }

  private overrideCompactionEvent(
    appendEvent: (event: SessionEvent) => Promise<void>,
    triggerOverride?: CompactionTriggerReason,
  ): (event: SessionEvent) => Promise<void> {
    if (!triggerOverride) return appendEvent;
    return async (event) => {
      if (event.type === 'compaction_marker') {
        await appendEvent({
          ...event,
          strategy: triggerOverride,
          triggerReason: triggerOverride,
        });
        return;
      }
      await appendEvent(event);
    };
  }
}
