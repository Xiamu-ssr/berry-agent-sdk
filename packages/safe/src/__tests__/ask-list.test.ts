import { describe, it, expect, vi } from 'vitest';
import { askList } from '../guards/ask-list.js';

const baseCtx = {
  session: { id: 'test', cwd: '/tmp', model: 'test' },
  callIndex: 1,
};

describe('askList', () => {
  it('allows unlisted tools without calling the bridge', async () => {
    const ask = vi.fn();
    const guard = askList({ tools: ['write_file'], ask });
    const result = await guard({ toolName: 'read_file', input: {}, ...baseCtx });
    expect(result.action).toBe('allow');
    expect(ask).not.toHaveBeenCalled();
  });

  it('fails closed when no bridge is installed', async () => {
    const guard = askList({ tools: ['write_file'] });
    const result = await guard({ toolName: 'write_file', input: { path: '/tmp/x' }, ...baseCtx });
    expect(result.action).toBe('deny');
    expect((result as any).reason).toContain('no approval bridge');
  });

  it('allows when the bridge approves', async () => {
    const guard = askList({
      tools: ['write_file'],
      ask: async () => ({ approved: true }),
    });
    const result = await guard({ toolName: 'write_file', input: { path: '/tmp/x' }, ...baseCtx });
    expect(result.action).toBe('allow');
  });

  it('denies with the human\'s note when the bridge rejects', async () => {
    const guard = askList({
      tools: ['write_file'],
      ask: async () => ({ approved: false, note: 'wrong target' }),
    });
    const result = await guard({ toolName: 'write_file', input: { path: '/tmp/x' }, ...baseCtx });
    expect(result.action).toBe('deny');
    expect((result as any).reason).toContain('wrong target');
  });

  it('auto-denies on bridge timeout rather than blocking the agent forever', async () => {
    const guard = askList({
      tools: ['write_file'],
      ask: () => new Promise(() => {/* never resolves */}),
      timeoutMs: 20,
    });
    const result = await guard({ toolName: 'write_file', input: { path: '/tmp/x' }, ...baseCtx });
    expect(result.action).toBe('deny');
    expect((result as any).reason).toContain('timed out');
  });

  it('forwards tool name, input, and reason to the bridge', async () => {
    const ask = vi.fn(async () => ({ approved: true }));
    const guard = askList({
      tools: ['shell'],
      ask,
      reason: 'shell exec needs sign-off',
    });
    await guard({ toolName: 'shell', input: { command: 'ls' }, ...baseCtx });
    expect(ask).toHaveBeenCalledTimes(1);
    const question = ask.mock.calls[0]![0];
    expect(question.toolName).toBe('shell');
    expect(question.input).toEqual({ command: 'ls' });
    expect(question.reason).toBe('shell exec needs sign-off');
  });
});
