import { describe, expect, it } from 'vitest';

import { runCompaction } from '../compaction-runner.js';
import type {
  AgentEvent,
  Provider,
  ProviderRequest,
  ProviderResponse,
  Session,
  ToolRegistration,
} from '../types.js';
import type { SessionEvent } from '../event-log/types.js';

class NoopProvider implements Provider {
  readonly type = 'anthropic' as const;

  async chat(_request: ProviderRequest): Promise<ProviderResponse> {
    throw new Error('provider.chat should not be called when custom compactionStrategy is used');
  }
}

describe('runCompaction', () => {
  it('writes enriched compaction_marker metadata to the event log', async () => {
    const session: Session = {
      id: 'session_1',
      messages: [
        { role: 'user', content: 'hello', createdAt: 1 },
        { role: 'assistant', content: [{ type: 'text', text: 'world' }], createdAt: 2 },
      ],
      createdAt: 1,
      lastAccessedAt: 2,
      metadata: {
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCacheReadTokens: 0,
        totalCacheWriteTokens: 0,
        compactionCount: 0,
        lastInputTokens: 175000,
      },
    };

    const appended: SessionEvent[] = [];
    const emitted: AgentEvent[] = [];

    // Use a custom strategy that shortens a message so tokensFreed > 0
    const result = await runCompaction({
      session,
      compactLevel: 'hard',
      provider: new NoopProvider(),
      systemPrompt: ['base'],
      allowedTools: [] as ToolRegistration[],
      emit: (event) => emitted.push(event),
      appendEvent: async (event) => { appended.push(event); },
      makeBase: () => ({ id: 'evt_1', timestamp: 123, sessionId: 'session_1', turnId: 'turn_1' }),
      compactionConfig: { contextWindow: 200000 },
      compactionStrategy: {
        async compact(messages) {
          // Simulate compaction: shorten the first message to free tokens
          const compacted = messages.map((m, i) =>
            i === 0 ? { ...m, content: 'hi' } : m,
          );
          return {
            messages: compacted,
            layersApplied: ['merge_messages'],
            tokensFreed: 1, // message-level freed (char-based)
          };
        },
      },
    });

    expect(result.compacted).toBe(true);

    const marker = appended.find((event): event is Extract<SessionEvent, { type: 'compaction_marker' }> => event.type === 'compaction_marker');
    expect(marker).toBeDefined();
    expect(marker).toEqual(expect.objectContaining({
      type: 'compaction_marker',
      strategy: 'threshold',
      triggerReason: 'threshold',
      // tokensFreed is now in full-context terms (contextBefore - contextAfter)
      contextBefore: 175000,
      thresholdPct: 0.875,
      contextWindow: 200000,
      layersApplied: ['merge_messages'],
    }));
    // tokensFreed should be > 0 since we shortened "hello" → "hi"
    expect(marker!.tokensFreed).toBeGreaterThan(0);
    // contextAfter should be less than contextBefore
    expect(marker!.contextAfter).toBeLessThan(175000);
    expect(typeof marker?.durationMs).toBe('number');

    expect(emitted).toContainEqual(expect.objectContaining({
      type: 'compaction',
      triggerReason: 'threshold',
      contextBefore: 175000,
      thresholdPct: 0.875,
      contextWindow: 200000,
      layersApplied: ['merge_messages'],
    }));
  });
});