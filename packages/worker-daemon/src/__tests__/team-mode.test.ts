// ============================================================
// @berry-agent/worker-daemon — team-mode unit tests
// ============================================================

import { describe, expect, it } from 'vitest';
import { AgentHome } from '@berry-agent/core';
import type { WorkerAgentSpec } from '@berry-agent/worker';
import { withTeamModeHostTools } from '../team-mode.js';

function stubResolve(): (wire: Parameters<typeof withTeamModeHostTools>[0]['arguments']) => WorkerAgentSpec {
  return ((wire) => ({
    agentId: wire.agentId,
    workspace: `/tmp/${wire.agentId}`,
    home: new AgentHome(`/tmp/${wire.agentId}`),
    model: wire.model,
    ensureDefaultMcpConfig: false,
  })) as ReturnType<typeof stubResolve>;
}

function stubFetch(handler: (url: string, init: RequestInit | undefined) => Response | Promise<Response>): typeof fetch {
  return (async (input: Request | string | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    return handler(url, init);
  }) as unknown as typeof fetch;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('withTeamModeHostTools', () => {
  it('leaves non-team agents untouched', () => {
    const wrapped = withTeamModeHostTools(stubResolve() as never, {
      a8sUrl: 'http://a8s', adminToken: 't',
    });
    const spec = wrapped({ agentId: 'a', workspace: 'a', model: 'tier:strong' });
    expect(spec.hostTools).toBeUndefined();
  });

  it('injects message_leader when labels.team=true + labels.leader present', () => {
    const wrapped = withTeamModeHostTools(stubResolve() as never, {
      a8sUrl: 'http://a8s', adminToken: 't',
    });
    const spec = wrapped({
      agentId: 'tm', workspace: 'tm', model: 'tier:strong',
      labels: { team: 'true', leader: 'lead', role: 'reviewer' },
    });
    const names = (spec.hostTools ?? []).map((t) => t.definition.name);
    expect(names).toContain('message_leader');
  });

  it('skips injection when team:true but leader label missing', () => {
    const wrapped = withTeamModeHostTools(stubResolve() as never, {
      a8sUrl: 'http://a8s', adminToken: 't',
      logger: { log: () => {}, warn: () => {}, error: () => {} },
    });
    const spec = wrapped({
      agentId: 'tm', workspace: 'tm', model: 'tier:strong',
      labels: { team: 'true' },
    });
    expect(spec.hostTools).toBeUndefined();
  });

  it('host-supplied hostTools win on name conflict; team tools are appended', () => {
    const customMessageLeader = {
      definition: { name: 'message_leader', description: 'custom', inputSchema: { type: 'object' as const, properties: {} } },
      execute: async () => ({ content: 'custom' }),
    };
    const baseResolve = ((wire: { agentId: string; workspace: string; model: string }) => ({
      agentId: wire.agentId,
      workspace: `/tmp/${wire.agentId}`,
      home: new AgentHome(`/tmp/${wire.agentId}`),
      model: wire.model,
      ensureDefaultMcpConfig: false,
      hostTools: [customMessageLeader],
    })) as never;
    const wrapped = withTeamModeHostTools(baseResolve, { a8sUrl: 'http://a8s', adminToken: 't' });
    const spec = wrapped({
      agentId: 'tm', workspace: 'tm', model: 'tier:strong',
      labels: { team: 'true', leader: 'lead' },
    });
    const tools = spec.hostTools ?? [];
    expect(tools).toHaveLength(1);
    expect(tools[0]).toBe(customMessageLeader);
  });

  it('message_leader posts a wake to a8s', async () => {
    let seenUrl = '';
    let seenBody: unknown = null;
    let seenAuth = '';
    const fetchImpl = stubFetch((url, init) => {
      seenUrl = url;
      seenBody = init?.body ? JSON.parse(init.body as string) : null;
      const headers = (init?.headers ?? {}) as Record<string, string>;
      seenAuth = headers.Authorization ?? headers.authorization ?? '';
      return jsonResponse(200, { wakeId: 'w1', dueAt: Date.now() });
    });
    const wrapped = withTeamModeHostTools(stubResolve() as never, {
      a8sUrl: 'http://a8s', adminToken: 'tok', fetch: fetchImpl,
    });
    const spec = wrapped({
      agentId: 'reviewer', workspace: 'reviewer', model: 'tier:strong',
      labels: { team: 'true', leader: 'coder' },
    });
    const tool = (spec.hostTools ?? []).find((t) => t.definition.name === 'message_leader')!;
    const result = await tool.execute({ content: 'done with review' }, { cwd: '/tmp' });
    expect(result.isError).not.toBe(true);
    expect(seenUrl).toContain('/v1/wakes/schedule');
    expect(seenAuth).toBe('Bearer tok');
    const body = seenBody as { agentId: string; reason: string; payload: { from: string; to: string; content: string } };
    expect(body.agentId).toBe('coder');
    expect(body.reason).toBe('teammate_message');
    expect(body.payload.from).toBe('reviewer');
    expect(body.payload.to).toBe('coder');
    expect(body.payload.content).toBe('done with review');
  });

  it('message_leader surfaces HTTP errors as isError', async () => {
    const fetchImpl = stubFetch(() => jsonResponse(500, { error: { code: 'boom', message: 'broke' } }));
    const wrapped = withTeamModeHostTools(stubResolve() as never, {
      a8sUrl: 'http://a8s', adminToken: 'tok', fetch: fetchImpl,
    });
    const spec = wrapped({
      agentId: 'tm', workspace: 'tm', model: 'tier:strong',
      labels: { team: 'true', leader: 'lead' },
    });
    const tool = (spec.hostTools ?? []).find((t) => t.definition.name === 'message_leader')!;
    const result = await tool.execute({ content: 'hi' }, { cwd: '/tmp' });
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/HTTP 500/);
  });

  it('message_leader rejects empty content', async () => {
    const wrapped = withTeamModeHostTools(stubResolve() as never, {
      a8sUrl: 'http://a8s', adminToken: 'tok',
    });
    const spec = wrapped({
      agentId: 'tm', workspace: 'tm', model: 'tier:strong',
      labels: { team: 'true', leader: 'lead' },
    });
    const tool = (spec.hostTools ?? []).find((t) => t.definition.name === 'message_leader')!;
    const result = await tool.execute({ content: '   ' }, { cwd: '/tmp' });
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/required/);
  });
});
