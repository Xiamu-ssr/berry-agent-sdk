import type { SystemPromptBlock } from '@berry-agent/small-shared-core';
import type { CompactionConfig, CompactionStrategy } from '../compaction/types.js';
import type { CompactionResult } from '../compaction/compactor.js';
import { preCompactMemoryFlush, runCompaction } from '../compaction/runner.js';
import type { EventLogStore, SessionEvent } from '../event-log/types.js';
import type { Provider } from '../provider-types.js';
import type { PromptPack } from '../prompts.js';
import type { SessionStore } from '../session-types.js';
import type { ToolRegistration } from '../tool-types.js';
import type { AgentMemory } from '../workspace/types.js';
import { generateId } from './ids.js';

export interface SessionCompactionDeps {
  readonly sessionStore: SessionStore;
  readonly eventLogStore?: EventLogStore;
  getMemory(): AgentMemory | undefined;
  getCompactionConfig(): CompactionConfig | undefined;
  getCompactionStrategy(): CompactionStrategy | undefined;
  getProvider(): Provider;
  getSystemPrompt(): readonly SystemPromptBlock[];
  getPromptPack(): PromptPack;
  getTools(): ReadonlyMap<string, ToolRegistration>;
  buildSystemPrompt(base: readonly SystemPromptBlock[]): Promise<SystemPromptBlock[]>;
}

/**
 * Manual session compaction entrypoint. This keeps host-triggered `/new`-style
 * compaction on the same SDK pipeline as automatic turn compaction.
 */
export async function compactSessionMessages(
  deps: SessionCompactionDeps,
  sessionId: string,
  _options?: { reason?: string },
): Promise<CompactionResult> {
  const session = await deps.sessionStore.load(sessionId);
  if (!session) throw new Error(`Session not found: ${sessionId}`);

  const fullSystemPrompt = await deps.buildSystemPrompt(deps.getSystemPrompt());
  const provider = deps.getProvider();
  const makeBase = () => ({
    id: generateId(),
    timestamp: Date.now(),
    sessionId,
    turnId: 'compact',
  });
  const appendEvent = async (event: SessionEvent) => {
    if (deps.eventLogStore) await deps.eventLogStore.append(sessionId, event);
  };

  const memory = deps.getMemory();
  if (memory) {
    await preCompactMemoryFlush({
      session,
      memory,
      provider,
      systemPrompt: fullSystemPrompt,
      promptPack: deps.getPromptPack(),
      emit: () => {},
      appendEvent,
      makeBase,
    });
  }

  const { result: compactResult } = await runCompaction({
    compactionStrategy: deps.getCompactionStrategy(),
    session,
    compactionConfig: deps.getCompactionConfig(),
    compactLevel: 'hard',
    provider,
    systemPrompt: fullSystemPrompt,
    promptPack: deps.getPromptPack(),
    allowedTools: Array.from(deps.getTools().values()),
    emit: () => {},
    appendEvent,
    makeBase,
  });

  await deps.sessionStore.save(session);

  if (deps.eventLogStore) {
    await deps.eventLogStore.append(sessionId, {
      ...makeBase(),
      type: 'messages_snapshot',
      messages: session.messages,
      reason: 'manual_compact',
    });
  }

  return compactResult;
}
