import { describe, it, expect } from 'vitest';
import { withAudit, createMemoryAuditSink } from '../audit/audit-logger.js';
import type { ToolGuard } from '@berry-agent/core';

describe('withAudit', () => {
  const baseCtx = {
    session: { id: 'test', cwd: '/tmp', model: 'test' },
    callIndex: 1,
  };

  it('records allow decisions', async () => {
    const { sink, entries } = createMemoryAuditSink();
    const guard: ToolGuard = async () => ({ action: 'allow' });
    const audited = withAudit(guard, sink);

    await audited({ toolName: 'read_file', input: { path: '/x' }, ...baseCtx });

    expect(entries).toHaveLength(1);
    expect(entries[0]!.toolName).toBe('read_file');
    expect(entries[0]!.decision).toBe('allow');
    expect(entries[0]!.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('records deny decisions with reason', async () => {
    const { sink, entries } = createMemoryAuditSink();
    const guard: ToolGuard = async () => ({ action: 'deny', reason: 'Too dangerous' });
    const audited = withAudit(guard, sink);

    const result = await audited({ toolName: 'bash', input: { command: 'rm -rf /' }, ...baseCtx });

    expect(result.action).toBe('deny');
    expect(entries).toHaveLength(1);
    expect(entries[0]!.decision).toBe('deny');
    expect(entries[0]!.reason).toBe('Too dangerous');
  });

  it('records multiple calls', async () => {
    const { sink, entries } = createMemoryAuditSink();
    const guard: ToolGuard = async ({ toolName }) =>
      toolName === 'bash' ? { action: 'deny', reason: 'no' } : { action: 'allow' };
    const audited = withAudit(guard, sink);

    await audited({ toolName: 'read_file', input: {}, ...baseCtx });
    await audited({ toolName: 'bash', input: {}, ...baseCtx });
    await audited({ toolName: 'search', input: {}, ...baseCtx });

    expect(entries).toHaveLength(3);
    expect(entries.map(e => e.decision)).toEqual(['allow', 'deny', 'allow']);
  });
});
