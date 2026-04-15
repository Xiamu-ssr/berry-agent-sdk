import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { FileEventLogStore } from '../jsonl-store.js';
import { DefaultContextStrategy } from '../context-builder.js';
import type { SessionEvent, SessionEventType } from '../types.js';

// ----- Helpers -----

const tempDirs: string[] = [];

async function makeStore(): Promise<{ store: FileEventLogStore; baseDir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'berry-event-log-'));
  tempDirs.push(dir);
  return { store: new FileEventLogStore(dir), baseDir: dir };
}

let eventCounter = 0;

function makeEvent<T extends SessionEventType>(
  type: T,
  sessionId: string,
  extra: Record<string, unknown> = {},
): SessionEvent {
  eventCounter++;
  return {
    id: `evt_${eventCounter}`,
    timestamp: Date.now() + eventCounter,
    sessionId,
    turnId: 'turn_1',
    type,
    ...extra,
  } as SessionEvent;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

// ============================================================
// FileEventLogStore Tests
// ============================================================

describe('FileEventLogStore', () => {
  it('appends and reads a single event', async () => {
    const { store } = await makeStore();
    const event = makeEvent('user_message', 'ses_1', { content: 'hello' });

    await store.append('ses_1', event);
    const events = await store.getEvents('ses_1');

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual(event);
  });

  it('appends multiple events and reads them in order', async () => {
    const { store } = await makeStore();
    const e1 = makeEvent('user_message', 'ses_1', { content: 'hello' });
    const e2 = makeEvent('assistant_message', 'ses_1', { content: [{ type: 'text', text: 'hi' }] });
    const e3 = makeEvent('query_end', 'ses_1', {
      result: { text: 'hi', sessionId: 'ses_1', usage: { inputTokens: 10, outputTokens: 5 }, totalUsage: { inputTokens: 10, outputTokens: 5 }, toolCalls: 0, compacted: false },
    });

    await store.append('ses_1', e1);
    await store.append('ses_1', e2);
    await store.append('ses_1', e3);

    const events = await store.getEvents('ses_1');
    expect(events).toHaveLength(3);
    expect(events[0].type).toBe('user_message');
    expect(events[1].type).toBe('assistant_message');
    expect(events[2].type).toBe('query_end');
  });

  it('appendBatch writes multiple events atomically', async () => {
    const { store } = await makeStore();
    const events = [
      makeEvent('query_start', 'ses_2', { prompt: 'test' }),
      makeEvent('user_message', 'ses_2', { content: 'test' }),
      makeEvent('assistant_message', 'ses_2', { content: [{ type: 'text', text: 'response' }] }),
    ];

    await store.appendBatch('ses_2', events);
    const read = await store.getEvents('ses_2');

    expect(read).toHaveLength(3);
    expect(read).toEqual(events);
  });

  it('appendBatch with empty array is a no-op', async () => {
    const { store } = await makeStore();
    await store.appendBatch('ses_empty', []);
    const events = await store.getEvents('ses_empty');
    expect(events).toHaveLength(0);
  });

  it('filters events by type', async () => {
    const { store } = await makeStore();
    await store.appendBatch('ses_3', [
      makeEvent('query_start', 'ses_3', { prompt: 'test' }),
      makeEvent('user_message', 'ses_3', { content: 'test' }),
      makeEvent('assistant_message', 'ses_3', { content: [{ type: 'text', text: 'hi' }] }),
      makeEvent('tool_use', 'ses_3', { name: 'echo', toolUseId: 'tu_1', input: {} }),
      makeEvent('tool_result', 'ses_3', { toolUseId: 'tu_1', content: 'result', isError: false }),
    ]);

    const toolEvents = await store.getEvents('ses_3', { types: ['tool_use', 'tool_result'] });
    expect(toolEvents).toHaveLength(2);
    expect(toolEvents[0].type).toBe('tool_use');
    expect(toolEvents[1].type).toBe('tool_result');
  });

  it('filters events by timestamp (since)', async () => {
    const { store } = await makeStore();
    const now = Date.now();
    const e1: SessionEvent = { id: 'e1', timestamp: now - 1000, sessionId: 's', turnId: 't', type: 'user_message', content: 'old' };
    const e2: SessionEvent = { id: 'e2', timestamp: now + 1000, sessionId: 's', turnId: 't', type: 'user_message', content: 'new' };
    await store.appendBatch('s', [e1, e2]);

    const events = await store.getEvents('s', { since: now });
    expect(events).toHaveLength(1);
    expect(events[0].id).toBe('e2');
  });

  it('filters events by from/to index range', async () => {
    const { store } = await makeStore();
    const events = Array.from({ length: 5 }, (_, i) =>
      makeEvent('user_message', 'ses_range', { content: `msg_${i}` }),
    );
    await store.appendBatch('ses_range', events);

    const slice = await store.getEvents('ses_range', { from: 1, to: 3 });
    expect(slice).toHaveLength(2);
    expect((slice[0] as { content: string }).content).toBe('msg_1');
    expect((slice[1] as { content: string }).content).toBe('msg_2');
  });

  it('count returns number of events', async () => {
    const { store } = await makeStore();
    await store.appendBatch('ses_count', [
      makeEvent('user_message', 'ses_count', { content: 'a' }),
      makeEvent('user_message', 'ses_count', { content: 'b' }),
      makeEvent('user_message', 'ses_count', { content: 'c' }),
    ]);

    const count = await store.count('ses_count');
    expect(count).toBe(3);
  });

  it('count returns 0 for non-existent session', async () => {
    const { store } = await makeStore();
    expect(await store.count('nonexistent')).toBe(0);
  });

  it('listSessions returns all session IDs', async () => {
    const { store } = await makeStore();
    await store.append('alpha', makeEvent('user_message', 'alpha', { content: 'a' }));
    await store.append('beta', makeEvent('user_message', 'beta', { content: 'b' }));

    const sessions = await store.listSessions();
    expect(sessions).toEqual(['alpha', 'beta']);
  });

  it('listSessions returns empty array when directory does not exist', async () => {
    const dir = join(tmpdir(), 'berry-event-log-nonexistent-' + Date.now());
    const store = new FileEventLogStore(dir);
    expect(await store.listSessions()).toEqual([]);
  });

  it('getEvents returns empty array for non-existent session', async () => {
    const { store } = await makeStore();
    expect(await store.getEvents('missing')).toEqual([]);
  });

  it('handles crash recovery: truncates incomplete last line', async () => {
    const { store, baseDir } = await makeStore();
    // Write a valid event first
    await store.append('ses_crash', makeEvent('user_message', 'ses_crash', { content: 'valid' }));

    // Simulate crash: append incomplete JSON to the file
    const sessionsDir = join(baseDir, '.berry', 'sessions');
    const filePath = join(sessionsDir, 'ses_crash.jsonl');
    const raw = await readFile(filePath, 'utf-8');
    await writeFile(filePath, raw + '{"id":"broken","type":"user_', 'utf-8');

    // Should recover: only the valid event is returned
    const events = await store.getEvents('ses_crash');
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('user_message');
  });

  it('handles combined filters: types + from/to', async () => {
    const { store } = await makeStore();
    await store.appendBatch('ses_combo', [
      makeEvent('user_message', 'ses_combo', { content: 'a' }),
      makeEvent('assistant_message', 'ses_combo', { content: [{ type: 'text', text: 'b' }] }),
      makeEvent('user_message', 'ses_combo', { content: 'c' }),
      makeEvent('assistant_message', 'ses_combo', { content: [{ type: 'text', text: 'd' }] }),
      makeEvent('user_message', 'ses_combo', { content: 'e' }),
    ]);

    // First filter by type (3 user_messages), then slice [1,2)
    const events = await store.getEvents('ses_combo', { types: ['user_message'], from: 1, to: 2 });
    expect(events).toHaveLength(1);
    expect((events[0] as { content: string }).content).toBe('c');
  });
});

// ============================================================
// DefaultContextStrategy Tests
// ============================================================

describe('DefaultContextStrategy', () => {
  const strategy = new DefaultContextStrategy();

  it('converts user_message and assistant_message events to messages', () => {
    const events: SessionEvent[] = [
      { id: 'e1', timestamp: 1, sessionId: 's', type: 'user_message', content: 'hello' },
      { id: 'e2', timestamp: 2, sessionId: 's', type: 'assistant_message', content: [{ type: 'text', text: 'hi there' }] },
    ];

    const messages = strategy.buildMessages(events);
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe('user');
    expect(messages[0].content).toBe('hello');
    expect(messages[1].role).toBe('assistant');
    expect(messages[1].content).toEqual([{ type: 'text', text: 'hi there' }]);
  });

  it('skips non-conversation events (metadata, api_call, query_start, query_end)', () => {
    const events: SessionEvent[] = [
      { id: 'e0', timestamp: 0, sessionId: 's', type: 'query_start', prompt: 'test' },
      { id: 'e1', timestamp: 1, sessionId: 's', type: 'user_message', content: 'hello' },
      { id: 'e2', timestamp: 2, sessionId: 's', type: 'api_call', model: 'test', inputTokens: 10, outputTokens: 5 },
      { id: 'e3', timestamp: 3, sessionId: 's', type: 'assistant_message', content: [{ type: 'text', text: 'hi' }] },
      { id: 'e4', timestamp: 4, sessionId: 's', type: 'metadata', key: 'test', value: 123 },
      { id: 'e5', timestamp: 5, sessionId: 's', type: 'query_end', result: { text: 'hi', sessionId: 's', usage: { inputTokens: 10, outputTokens: 5 }, totalUsage: { inputTokens: 10, outputTokens: 5 }, toolCalls: 0, compacted: false } },
    ];

    const messages = strategy.buildMessages(events);
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe('user');
    expect(messages[1].role).toBe('assistant');
  });

  it('handles tool_use and tool_result events correctly', () => {
    const events: SessionEvent[] = [
      { id: 'e1', timestamp: 1, sessionId: 's', type: 'user_message', content: 'use echo' },
      { id: 'e2', timestamp: 2, sessionId: 's', type: 'assistant_message', content: [{ type: 'text', text: 'calling echo' }] },
      { id: 'e3', timestamp: 3, sessionId: 's', type: 'tool_use', name: 'echo', toolUseId: 'tu_1', input: { value: 'test' } },
      { id: 'e4', timestamp: 4, sessionId: 's', type: 'tool_result', toolUseId: 'tu_1', content: 'echoed: test', isError: false },
      { id: 'e5', timestamp: 5, sessionId: 's', type: 'assistant_message', content: [{ type: 'text', text: 'done' }] },
    ];

    const messages = strategy.buildMessages(events);
    // user_message, assistant (text + tool_use merged), user (tool_result), assistant (done)
    expect(messages).toHaveLength(4);

    // First message: user
    expect(messages[0].role).toBe('user');
    expect(messages[0].content).toBe('use echo');

    // Second message: assistant (text + tool_use merged)
    expect(messages[1].role).toBe('assistant');
    const assistantContent = messages[1].content as Array<{ type: string }>;
    expect(assistantContent).toHaveLength(2);
    expect(assistantContent[0].type).toBe('text');
    expect(assistantContent[1].type).toBe('tool_use');

    // Third message: user (tool_result)
    expect(messages[2].role).toBe('user');
    const toolResultContent = messages[2].content as Array<{ type: string }>;
    expect(toolResultContent[0].type).toBe('tool_result');

    // Fourth message: assistant (done)
    expect(messages[3].role).toBe('assistant');
  });

  it('starts from last compaction_marker', () => {
    const events: SessionEvent[] = [
      { id: 'e1', timestamp: 1, sessionId: 's', type: 'user_message', content: 'old message' },
      { id: 'e2', timestamp: 2, sessionId: 's', type: 'assistant_message', content: [{ type: 'text', text: 'old response' }] },
      { id: 'e3', timestamp: 3, sessionId: 's', type: 'compaction_marker', strategy: 'threshold', tokensFreed: 5000 },
      { id: 'e4', timestamp: 4, sessionId: 's', type: 'user_message', content: 'new message' },
      { id: 'e5', timestamp: 5, sessionId: 's', type: 'assistant_message', content: [{ type: 'text', text: 'new response' }] },
    ];

    const messages = strategy.buildMessages(events);
    expect(messages).toHaveLength(2);
    expect(messages[0].content).toBe('new message');
    expect(messages[1].content).toEqual([{ type: 'text', text: 'new response' }]);
  });

  it('handles multiple compaction markers (uses the last one)', () => {
    const events: SessionEvent[] = [
      { id: 'e1', timestamp: 1, sessionId: 's', type: 'user_message', content: 'ancient' },
      { id: 'e2', timestamp: 2, sessionId: 's', type: 'compaction_marker', strategy: 'threshold', tokensFreed: 3000 },
      { id: 'e3', timestamp: 3, sessionId: 's', type: 'user_message', content: 'middle' },
      { id: 'e4', timestamp: 4, sessionId: 's', type: 'compaction_marker', strategy: 'overflow_retry', tokensFreed: 2000 },
      { id: 'e5', timestamp: 5, sessionId: 's', type: 'user_message', content: 'latest' },
    ];

    const messages = strategy.buildMessages(events);
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('latest');
  });

  it('merges adjacent same-role messages', () => {
    const events: SessionEvent[] = [
      { id: 'e1', timestamp: 1, sessionId: 's', type: 'user_message', content: 'part 1' },
      { id: 'e2', timestamp: 2, sessionId: 's', type: 'user_message', content: 'part 2' },
      { id: 'e3', timestamp: 3, sessionId: 's', type: 'assistant_message', content: [{ type: 'text', text: 'reply' }] },
    ];

    const messages = strategy.buildMessages(events);
    expect(messages).toHaveLength(2);
    // First message is merged user: 'part 1' + 'part 2' → ContentBlock[]
    expect(messages[0].role).toBe('user');
    const mergedContent = messages[0].content as Array<{ type: string; text: string }>;
    expect(mergedContent).toHaveLength(2);
    expect(mergedContent[0].text).toBe('part 1');
    expect(mergedContent[1].text).toBe('part 2');
  });

  it('returns empty messages for empty event list', () => {
    expect(strategy.buildMessages([])).toEqual([]);
  });

  it('returns empty messages when all events are before compaction marker', () => {
    const events: SessionEvent[] = [
      { id: 'e1', timestamp: 1, sessionId: 's', type: 'user_message', content: 'old' },
      { id: 'e2', timestamp: 2, sessionId: 's', type: 'compaction_marker', strategy: 'threshold', tokensFreed: 1000 },
    ];
    expect(strategy.buildMessages(events)).toEqual([]);
  });

  it('groups multiple tool_result events into one user message', () => {
    const events: SessionEvent[] = [
      { id: 'e1', timestamp: 1, sessionId: 's', type: 'user_message', content: 'run tools' },
      { id: 'e2', timestamp: 2, sessionId: 's', type: 'assistant_message', content: [
        { type: 'tool_use', id: 'tu_1', name: 'a', input: {} },
        { type: 'tool_use', id: 'tu_2', name: 'b', input: {} },
      ]},
      { id: 'e3', timestamp: 3, sessionId: 's', type: 'tool_use', name: 'a', toolUseId: 'tu_1', input: {} },
      { id: 'e4', timestamp: 4, sessionId: 's', type: 'tool_use', name: 'b', toolUseId: 'tu_2', input: {} },
      { id: 'e5', timestamp: 5, sessionId: 's', type: 'tool_result', toolUseId: 'tu_1', content: 'result_a', isError: false },
      { id: 'e6', timestamp: 6, sessionId: 's', type: 'tool_result', toolUseId: 'tu_2', content: 'result_b', isError: false },
    ];

    const messages = strategy.buildMessages(events);
    // user, assistant (with tool_use blocks merged), user (tool_results grouped)
    expect(messages).toHaveLength(3);
    const toolResultMsg = messages[2];
    expect(toolResultMsg.role).toBe('user');
    const blocks = toolResultMsg.content as Array<{ type: string; toolUseId: string }>;
    expect(blocks).toHaveLength(2);
    expect(blocks[0].toolUseId).toBe('tu_1');
    expect(blocks[1].toolUseId).toBe('tu_2');
  });
});
