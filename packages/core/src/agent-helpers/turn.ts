import type { ContentBlock } from '../content-types.js';
import type { Session } from '../session-types.js';
import type { AgentEvent, QueryOptions, QueryResult } from '../agent-runtime-types.js';
import type { EventLogStore, SessionEvent } from '../event-log/types.js';
import { generateEventId, generateTurnId } from './ids.js';
import { repairOrphanToolUses } from './messages.js';
import type { AgentRunState } from './run-state.js';

export interface AgentTurnDeps {
  readonly runState: AgentRunState;
  readonly memoryReady: Promise<void>;
  readonly eventLogStore?: EventLogStore;
  readonly resetProviderResolver: () => void;
  readonly resolveSession: (options?: QueryOptions) => Promise<Session>;
  readonly emit: (event: AgentEvent, onEvent?: (event: AgentEvent) => void) => void;
  readonly onQueryStart?: (session: Session, prompt: string | ContentBlock[]) => void | Promise<void>;
  readonly onQueryEnd?: (session: Session, result: QueryResult) => void | Promise<void>;
  readonly runQueryLoop: (
    session: Session,
    prompt: string | ContentBlock[],
    options: QueryOptions | undefined,
    emit: (event: AgentEvent) => void,
    appendEvent: (event: SessionEvent) => Promise<void>,
    makeBase: () => { id: string; timestamp: number; sessionId: string; turnId?: string },
    log: EventLogStore | undefined,
  ) => Promise<QueryResult>;
}

export async function runAgentTurn(
  deps: AgentTurnDeps,
  prompt: string | ContentBlock[],
  options?: QueryOptions,
): Promise<QueryResult> {
  if (deps.runState.isDestroyed) {
    throw new Error('Agent has been destroyed; create a new instance to continue');
  }
  await deps.memoryReady;

  deps.resetProviderResolver();
  const session = await deps.resolveSession(options);
  repairOrphanToolUses(session.messages);

  const activeTurn = deps.runState.startAbortableTurn(options);
  const pauseController = activeTurn.controller;
  let pausedReason: string | undefined;
  const queryOptions = activeTurn.options;

  const emit = (event: AgentEvent) => deps.emit(event, queryOptions.onEvent);
  const log = deps.eventLogStore;
  const turnId = log ? generateTurnId() : undefined;
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

  if (deps.onQueryStart) {
    await deps.onQueryStart(session, prompt);
  }

  await appendEvent({ ...makeBase(), type: 'query_start', prompt });
  emit({ type: 'query_start', prompt, sessionId: session.id });

  session.messages.push({
    role: 'user',
    content: prompt,
    createdAt: Date.now(),
  });
  await appendEvent({ ...makeBase(), type: 'user_message', content: prompt });

  deps.runState.markQuerying('thinking');

  try {
    const result = await deps.runQueryLoop(
      session,
      prompt,
      queryOptions,
      emit,
      appendEvent,
      makeBase,
      log,
    );
    if (deps.onQueryEnd) {
      await deps.onQueryEnd(session, result);
    }
    return result;
  } catch (err) {
    pausedReason = deps.runState.pausedReasonFor(pauseController);
    const errorText = pausedReason
      ? `Paused: ${pausedReason}`
      : err instanceof Error ? err.message : String(err);
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
      error: errorText,
    };
    await appendEvent({ ...makeBase(), type: 'query_end', result: errorResult }).catch(() => {});
    emit({ type: 'query_end', result: errorResult });
    if (deps.onQueryEnd) {
      try { await deps.onQueryEnd(session, errorResult); } catch { /* ignore hook errors during failure cleanup */ }
    }
    throw err;
  } finally {
    deps.runState.finishAbortableTurn(pauseController, pausedReason);
  }
}
