import { describe, it, expect } from 'vitest';
import { denyList, allowList, directoryScope, rateLimiter, compositeGuard } from '../guards/rules.js';

const baseCtx = {
  session: { id: 'test', cwd: '/tmp', model: 'test' },
  callIndex: 1,
};

describe('denyList', () => {
  it('blocks tool calls matching a pattern', async () => {
    const guard = denyList(['rm -rf', 'DROP TABLE']);
    const result = await guard({ toolName: 'bash', input: { command: 'rm -rf /' }, ...baseCtx });
    expect(result.action).toBe('deny');
    expect((result as any).reason).toContain('rm -rf');
  });

  it('allows tool calls not matching any pattern', async () => {
    const guard = denyList(['rm -rf']);
    const result = await guard({ toolName: 'read_file', input: { path: '/etc/hosts' }, ...baseCtx });
    expect(result.action).toBe('allow');
  });
});

describe('allowList', () => {
  it('allows listed tools', async () => {
    const guard = allowList(['read_file', 'search']);
    const result = await guard({ toolName: 'read_file', input: {}, ...baseCtx });
    expect(result.action).toBe('allow');
  });

  it('denies unlisted tools', async () => {
    const guard = allowList(['read_file']);
    const result = await guard({ toolName: 'write_file', input: {}, ...baseCtx });
    expect(result.action).toBe('deny');
    expect((result as any).reason).toContain('not in allow list');
  });
});

describe('directoryScope', () => {
  it('allows paths inside the directory', async () => {
    const guard = directoryScope('/Users/test/project');
    const result = await guard({
      toolName: 'write_file',
      input: { path: '/Users/test/project/src/main.ts' },
      ...baseCtx,
    });
    expect(result.action).toBe('allow');
  });

  it('denies paths outside the directory', async () => {
    const guard = directoryScope('/Users/test/project');
    const result = await guard({
      toolName: 'write_file',
      input: { path: '/etc/passwd' },
      ...baseCtx,
    });
    expect(result.action).toBe('deny');
    expect((result as any).reason).toContain('outside allowed directory');
  });

  it('allows when no path fields are present', async () => {
    const guard = directoryScope('/Users/test/project');
    const result = await guard({
      toolName: 'search',
      input: { query: 'hello' },
      ...baseCtx,
    });
    expect(result.action).toBe('allow');
  });
});

describe('rateLimiter', () => {
  it('allows calls within the limit', async () => {
    const guard = rateLimiter({ maxCalls: 3, windowMs: 1000 });
    const r1 = await guard({ toolName: 'a', input: {}, ...baseCtx });
    const r2 = await guard({ toolName: 'b', input: {}, ...baseCtx });
    const r3 = await guard({ toolName: 'c', input: {}, ...baseCtx });
    expect(r1.action).toBe('allow');
    expect(r2.action).toBe('allow');
    expect(r3.action).toBe('allow');
  });

  it('denies calls exceeding the limit', async () => {
    const guard = rateLimiter({ maxCalls: 2, windowMs: 1000 });
    await guard({ toolName: 'a', input: {}, ...baseCtx });
    await guard({ toolName: 'b', input: {}, ...baseCtx });
    const r3 = await guard({ toolName: 'c', input: {}, ...baseCtx });
    expect(r3.action).toBe('deny');
    expect((r3 as any).reason).toContain('Rate limit');
  });
});

describe('compositeGuard', () => {
  it('first deny wins', async () => {
    const guard = compositeGuard(
      allowList(['read_file', 'write_file']),
      denyList(['rm -rf']),
    );
    // Both allow
    const r1 = await guard({ toolName: 'read_file', input: {}, ...baseCtx });
    expect(r1.action).toBe('allow');

    // First denies
    const r2 = await guard({ toolName: 'bash', input: {}, ...baseCtx });
    expect(r2.action).toBe('deny');
  });

  it('all must allow', async () => {
    const guard = compositeGuard(
      allowList(['write_file']),
      directoryScope('/tmp/project'),
    );
    // write_file allowed + path inside → allow
    const r1 = await guard({ toolName: 'write_file', input: { path: '/tmp/project/x.ts' }, ...baseCtx });
    expect(r1.action).toBe('allow');

    // write_file allowed + path outside → deny
    const r2 = await guard({ toolName: 'write_file', input: { path: '/etc/passwd' }, ...baseCtx });
    expect(r2.action).toBe('deny');
  });
});
