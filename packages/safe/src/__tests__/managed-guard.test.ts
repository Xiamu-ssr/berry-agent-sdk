import { describe, expect, it, vi } from 'vitest';
import { AgentScope } from '@berry-agent/core';
import { buildManagedToolGuard, DEFAULT_HITL_TOOLS } from '../managed-guard.js';

const ctx = {
  session: { id: 'session_1', cwd: '/tmp/project', model: 'test', turnId: 'turn_1' },
  callIndex: 1,
};

describe('buildManagedToolGuard', () => {
  it('keeps trust mode narrow: catastrophic denies only', async () => {
    const guard = buildManagedToolGuard('trust', {
      scope: new AgentScope('/tmp/agent', '/tmp/project'),
    });

    const write = await guard({
      toolName: 'write_file',
      input: { path: '/etc/hosts', content: 'x' },
      ...ctx,
    });
    expect(write.action).toBe('allow');

    const destructive = await guard({
      toolName: 'shell',
      input: { command: 'rm -rf /' },
      ...ctx,
    });
    expect(destructive.action).toBe('deny');
  });

  it('applies writable scope and broad denies in default mode', async () => {
    const guard = buildManagedToolGuard('default', {
      scope: new AgentScope('/tmp/agent', '/tmp/project'),
    });

    const outside = await guard({
      toolName: 'write_file',
      input: { path: '/etc/hosts', content: 'x' },
      ...ctx,
    });
    expect(outside.action).toBe('deny');

    const destructive = await guard({
      toolName: 'shell',
      input: { command: 'psql -c "DROP TABLE users"' },
      ...ctx,
    });
    expect(destructive.action).toBe('deny');
  });

  it('uses HITL for built-in side-effect tools in auto mode', async () => {
    const ask = vi.fn(async () => ({ approved: true }));
    const guard = buildManagedToolGuard('auto', {
      scope: new AgentScope('/tmp/agent', '/tmp/project'),
      askBridge: ask,
      agentId: 'agent_1',
    });

    const result = await guard({
      toolName: 'shell',
      input: { command: 'pwd' },
      ...ctx,
    });

    expect(result.action).toBe('allow');
    expect(DEFAULT_HITL_TOOLS).toContain('shell');
    expect(ask).toHaveBeenCalledWith(expect.objectContaining({
      agentId: 'agent_1',
      toolName: 'shell',
      reason: 'Human approval required (safety mode: auto)',
    }));
  });
});
