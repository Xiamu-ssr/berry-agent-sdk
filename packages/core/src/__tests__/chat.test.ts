import { describe, expect, it } from 'vitest';

import { toChatMessages, toChatTimeline } from '../chat.js';
import type { Message } from '../types.js';
import type { SessionEvent } from '../event-log/types.js';

describe('toChatMessages', () => {
  it('pairs tool_use blocks with tool_result blocks from messages', () => {
    const messages: Message[] = [
      { role: 'user', content: 'use echo', createdAt: 1 },
      {
        role: 'assistant',
        createdAt: 2,
        content: [
          { type: 'text', text: 'calling echo' },
          { type: 'tool_use', id: 'tu_1', name: 'echo', input: { value: 'hello' } },
        ],
      },
      {
        role: 'user',
        createdAt: 3,
        content: [
          { type: 'tool_result', toolUseId: 'tu_1', content: 'echo: hello' },
        ],
      },
    ];

    const result = toChatMessages(messages);

    expect(result).toHaveLength(2);
    expect(result[1]).toEqual(expect.objectContaining({
      role: 'assistant',
      content: 'calling echo',
      toolCalls: [
        expect.objectContaining({
          name: 'echo',
          result: 'echo: hello',
        }),
      ],
    }));
  });
});

describe('toChatTimeline', () => {
  it('preserves full history and inserts compaction markers as system items', () => {
    const events: SessionEvent[] = [
      { id: 'e1', timestamp: 1, sessionId: 's', type: 'user_message', content: 'old user message' },
      { id: 'e2', timestamp: 2, sessionId: 's', type: 'assistant_message', content: [{ type: 'text', text: 'old assistant reply' }] },
      {
        id: 'e3',
        timestamp: 3,
        sessionId: 's',
        type: 'compaction_marker',
        strategy: 'threshold',
        triggerReason: 'threshold',
        tokensFreed: 45000,
        contextBefore: 175000,
        contextAfter: 130000,
        thresholdPct: 0.875,
        contextWindow: 200000,
        layersApplied: ['clear_thinking', 'summarize'],
        durationMs: 3200,
      },
      { id: 'e4', timestamp: 4, sessionId: 's', type: 'user_message', content: 'new user message' },
      { id: 'e5', timestamp: 5, sessionId: 's', type: 'assistant_message', content: [{ type: 'text', text: 'new assistant reply' }] },
    ];

    const timeline = toChatTimeline(events);

    expect(timeline).toHaveLength(5);
    expect(timeline[0]).toEqual(expect.objectContaining({ role: 'user', content: 'old user message' }));
    expect(timeline[1]).toEqual(expect.objectContaining({ role: 'assistant', content: 'old assistant reply' }));
    expect(timeline[2]).toEqual(expect.objectContaining({
      role: 'system',
      kind: 'compaction_marker',
      content: expect.stringContaining('45,000'),
      compaction: expect.objectContaining({
        strategy: 'threshold',
        triggerReason: 'threshold',
        tokensFreed: 45000,
        contextBefore: 175000,
        contextAfter: 130000,
        contextWindow: 200000,
        layersApplied: ['clear_thinking', 'summarize'],
      }),
    }));
    expect(timeline[3]).toEqual(expect.objectContaining({ role: 'user', content: 'new user message' }));
    expect(timeline[4]).toEqual(expect.objectContaining({ role: 'assistant', content: 'new assistant reply' }));
  });

  it('pairs tool results from event log and does not emit standalone tool_result items', () => {
    const events: SessionEvent[] = [
      { id: 'e1', timestamp: 1, sessionId: 's', type: 'user_message', content: 'run the tool' },
      {
        id: 'e2',
        timestamp: 2,
        sessionId: 's',
        type: 'assistant_message',
        content: [
          { type: 'text', text: 'running search' },
          { type: 'tool_use', id: 'tu_1', name: 'search', input: { query: 'berry sdk' } },
        ],
      },
      { id: 'e3', timestamp: 3, sessionId: 's', type: 'tool_use', name: 'search', toolUseId: 'tu_1', input: { query: 'berry sdk' } },
      { id: 'e4', timestamp: 4, sessionId: 's', type: 'tool_result', toolUseId: 'tu_1', content: 'result payload', isError: false },
    ];

    const timeline = toChatTimeline(events);

    expect(timeline).toHaveLength(2);
    expect(timeline[1]).toEqual(expect.objectContaining({
      role: 'assistant',
      content: 'running search',
      toolCalls: [
        expect.objectContaining({
          name: 'search',
          result: 'result payload',
          isError: false,
        }),
      ],
    }));
  });
});
