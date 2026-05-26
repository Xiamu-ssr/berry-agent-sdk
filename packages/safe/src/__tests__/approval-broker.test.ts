import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApprovalBroker } from '../approval-broker.js';
import type { AskQuestion } from '../guards/ask-list.js';

const question: AskQuestion = {
  toolName: 'shell',
  input: { command: 'pwd' },
  agentId: 'agent_1',
  session: { id: 'session_1', cwd: '/tmp/workspace', model: 'test-model', turnId: 'turn_1' },
  callIndex: 1,
  reason: 'needs approval',
};

afterEach(() => {
  vi.useRealTimers();
});

describe('ApprovalBroker', () => {
  it('creates pending approvals and resolves them by id', async () => {
    const onAsk = vi.fn();
    const onResolve = vi.fn();
    const broker = new ApprovalBroker({
      id: () => 'ask_1',
      now: () => 123,
      timeoutMs: 0,
      onAsk,
      onResolve,
    });

    const answerPromise = broker.askBridge(question);

    expect(broker.listPending()).toEqual([{ id: 'ask_1', question, createdAt: 123 }]);
    expect(onAsk).toHaveBeenCalledWith({ id: 'ask_1', question, createdAt: 123 });

    const resolved = broker.answer('ask_1', { approved: true });
    await expect(answerPromise).resolves.toEqual({ approved: true });

    expect(resolved).toEqual({ id: 'ask_1', question, createdAt: 123 });
    expect(broker.listPending()).toEqual([]);
    expect(onResolve).toHaveBeenCalledWith(
      { id: 'ask_1', question, createdAt: 123 },
      { approved: true },
    );
  });

  it('returns null when answering an unknown approval id', () => {
    const broker = new ApprovalBroker({ timeoutMs: 0 });
    expect(broker.answer('missing', { approved: false })).toBeNull();
  });

  it('auto-denies and clears pending approvals on broker timeout', async () => {
    vi.useFakeTimers();
    const onResolve = vi.fn();
    const broker = new ApprovalBroker({
      id: () => 'ask_1',
      now: () => 123,
      timeoutMs: 20,
      onResolve,
    });

    const answerPromise = broker.ask(question);
    expect(broker.listPending()).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(20);

    await expect(answerPromise).resolves.toEqual({
      approved: false,
      note: 'timed out after 20ms',
    });
    expect(broker.listPending()).toEqual([]);
    expect(onResolve).toHaveBeenCalledTimes(1);
  });
});
