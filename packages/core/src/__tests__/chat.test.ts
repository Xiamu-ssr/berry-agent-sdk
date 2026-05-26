import { describe, expect, it } from 'vitest';

import { createPendingUserChatMessage, timelineEventFromAgentEvent, toAgentSessionView } from '../chat.js';
import type { AnnotationContent } from '../index.js';
import type { SessionEvent } from '../event-log/types.js';

describe('timelineEventFromAgentEvent', () => {
  it('maps live SDK agent events to replay-compatible timeline events', () => {
    const event = timelineEventFromAgentEvent({
      type: 'guard_decision',
      toolName: 'shell',
      input: { command: 'pwd' },
      decision: { action: 'deny', reason: 'blocked' },
      callIndex: 1,
      durationMs: 12,
    }, { id: 'live_1', timestamp: 10 });

    expect(event).toEqual(expect.objectContaining({
      id: 'live_1',
      kind: 'guard',
      title: '安全策略：deny',
      detail: 'shell',
      timestamp: 10,
      tone: 'bad',
    }));
  });
});

describe('toAgentSessionView', () => {
  const annotation: AnnotationContent = {
    type: 'annotation',
    body: 'Button label is unclear',
    source: { url: 'https://example.test/page', title: 'Example' },
    rect: { x: 10, y: 20, width: 120, height: 40 },
    viewport: { width: 800, height: 600 },
    image: { data: 'aW1hZ2U=', mediaType: 'image/png', width: 152, height: 72 },
  };

  it('preserves human annotation blocks in SDK session views', () => {
    const view = toAgentSessionView({
      id: 's',
      messages: [
        { role: 'user', content: [annotation], createdAt: 1 },
      ],
      createdAt: 1,
      lastAccessedAt: 1,
      metadata: {
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCacheReadTokens: 0,
        totalCacheWriteTokens: 0,
        compactionCount: 0,
      },
    });

    expect(view.messages[0]).toEqual(expect.objectContaining({
      role: 'user',
      content: expect.stringContaining('Button label is unclear'),
      blocks: [annotation],
    }));
  });

  it('hydrates rich UI messages from events instead of compacted messages', () => {
    const session = {
      id: 's',
      messages: [
        { role: 'user' as const, content: 'compacted summary', createdAt: 10 },
      ],
      createdAt: 10,
      lastAccessedAt: 20,
      metadata: {
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCacheReadTokens: 0,
        totalCacheWriteTokens: 0,
        compactionCount: 0,
      },
    };
    const events: SessionEvent[] = [
      { id: 'e1', timestamp: 1, sessionId: 's', turnId: 't1', type: 'query_start', prompt: 'run the tool' },
      { id: 'e2', timestamp: 2, sessionId: 's', turnId: 't1', type: 'user_message', content: 'run the tool' },
      {
        id: 'e3',
        timestamp: 3,
        sessionId: 's',
        turnId: 't1',
        type: 'api_response',
        requestId: 'r1',
        model: 'm',
        content: [{ type: 'text', text: 'running' }],
        stopReason: 'tool_use',
        usage: { inputTokens: 12, outputTokens: 3 },
      },
      {
        id: 'e4',
        timestamp: 4,
        sessionId: 's',
        turnId: 't1',
        type: 'assistant_message',
        content: [
          { type: 'text', text: 'running' },
          { type: 'tool_use', id: 'tu_1', name: 'echo', input: { value: 'hello' } },
        ],
      },
      { id: 'e5', timestamp: 5, sessionId: 's', turnId: 't1', type: 'tool_use_end', toolUseId: 'tu_1', output: 'hello', isError: false },
      { id: 'e6', timestamp: 6, sessionId: 's', turnId: 't1', type: 'query_end', result: { text: 'done', sessionId: 's', usage: { inputTokens: 12, outputTokens: 3 }, totalUsage: { inputTokens: 12, outputTokens: 3 }, toolCalls: 1, compacted: false } },
    ];

    const view = toAgentSessionView(session, { events, agentId: 'a' });

    expect(view.agentId).toBe('a');
    expect(view.title).toBe('run the tool');
    expect(view.messages[0]).toEqual(expect.objectContaining({ role: 'user', content: 'run the tool' }));
    expect(view.messages[1]).toEqual(expect.objectContaining({
      role: 'assistant',
      content: 'running',
      toolCalls: [expect.objectContaining({ name: 'echo', result: 'hello' })],
      inferences: [expect.objectContaining({ model: 'm', inputTokens: 12 })],
    }));
  });

  it('replays approval requests and decisions as guard timeline events', () => {
    const session = {
      id: 's',
      messages: [],
      createdAt: 1,
      lastAccessedAt: 10,
      metadata: {
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCacheReadTokens: 0,
        totalCacheWriteTokens: 0,
        compactionCount: 0,
      },
    };
    const events: SessionEvent[] = [
      { id: 'e1', timestamp: 1, sessionId: 's', turnId: 't1', type: 'user_message', content: 'run shell' },
      {
        id: 'e2',
        timestamp: 2,
        sessionId: 's',
        turnId: 't1',
        type: 'assistant_message',
        content: [{ type: 'tool_use', id: 'tu_1', name: 'shell', input: { command: 'pwd' } }],
      },
      { id: 'e3', timestamp: 3, sessionId: 's', turnId: 't1', type: 'tool_use_start', toolUseId: 'tu_1', name: 'shell', input: { command: 'pwd' } },
      {
        id: 'e4',
        timestamp: 4,
        sessionId: 's',
        turnId: 't1',
        type: 'approval_request',
        approvalId: 'approval_1',
        agentId: 'agent_1',
        toolName: 'shell',
        input: { command: 'pwd' },
        callIndex: 1,
        reason: 'needs approval',
        cwd: '/tmp/workspace',
        model: 'test-model',
      },
      {
        id: 'e5',
        timestamp: 5,
        sessionId: 's',
        turnId: 't1',
        type: 'approval_decision',
        approvalId: 'approval_1',
        agentId: 'agent_1',
        toolName: 'shell',
        approved: true,
        note: 'ok',
      },
    ];

    const view = toAgentSessionView(session, { events, agentId: 'agent_1' });
    const assistant = view.messages.find((message) => message.role === 'assistant');

    expect(assistant?.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'guard', title: '等待人工审批', detail: 'shell', tone: 'warn' }),
      expect.objectContaining({ kind: 'guard', title: '人工审批通过', detail: 'shell', tone: 'good' }),
    ]));
  });

  it('marks sessions with an unclosed query_start as interrupted', () => {
    const session = {
      id: 's',
      messages: [],
      createdAt: 1,
      lastAccessedAt: 1,
      metadata: {
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCacheReadTokens: 0,
        totalCacheWriteTokens: 0,
        compactionCount: 0,
      },
    };

    const view = toAgentSessionView(session, {
      events: [
        { id: 'e1', timestamp: 1, sessionId: 's', turnId: 't1', type: 'query_start', prompt: 'hi' },
      ],
    });

    expect(view.status).toBe('interrupted');
    expect(view.messages[0]).toEqual(expect.objectContaining({ role: 'assistant', status: 'failed' }));
  });

  it('creates a transient pending user message for streaming UIs', () => {
    const message = createPendingUserChatMessage([
      { type: 'image', data: 'abc', mediaType: 'image/png' },
      { type: 'text', text: 'describe it' },
    ], { requestId: 'r', timestamp: 1 });

    expect(message).toEqual(expect.objectContaining({
      role: 'user',
      content: '[image] describe it',
      status: 'pending',
      requestId: 'r',
    }));
    expect(message.blocks).toHaveLength(2);
  });
});
