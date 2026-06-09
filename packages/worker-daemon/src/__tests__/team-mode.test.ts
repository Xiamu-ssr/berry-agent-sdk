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
    projectRoot: wire.projectRoot,
    home: new AgentHome(`/tmp/${wire.agentId}`),
    model: wire.model,
    ensureDefaultMcpConfig: false,
  })) as ReturnType<typeof stubResolve>;
}

/** Records every request a tool makes, returns canned bodies keyed by path fragment. */
function recordingFetch(routes: Array<{ match: string; status?: number; body: unknown }>): {
  fetch: typeof fetch;
  calls: Array<{ method: string; url: string; body: unknown }>;
} {
  const calls: Array<{ method: string; url: string; body: unknown }> = [];
  const fetchImpl = (async (input: Request | string | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(init.body as string) : null;
    calls.push({ method, url, body });
    const route = routes.find((r) => url.includes(r.match) && (r.status ?? 200) < 400)
      ?? routes.find((r) => url.includes(r.match));
    const status = route?.status ?? 200;
    return new Response(JSON.stringify(route?.body ?? {}), { status, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { fetch: fetchImpl, calls };
}

const PROJECT = '/code/acme';

describe('withTeamModeHostTools — gating', () => {
  it('leaves non-team agents untouched', () => {
    const wrapped = withTeamModeHostTools(stubResolve() as never, { a8sUrl: 'http://a8s', adminToken: 't' });
    const spec = wrapped({ agentId: 'a', workspace: 'a', model: 'tier:strong' });
    expect(spec.hostTools).toBeUndefined();
  });

  it('skips when team:true but no projectRoot', () => {
    const wrapped = withTeamModeHostTools(stubResolve() as never, {
      a8sUrl: 'http://a8s', adminToken: 't', logger: { log() {}, warn() {}, error() {} },
    });
    const spec = wrapped({ agentId: 'tm', workspace: 'tm', model: 'tier:strong', labels: { team: 'true', leader: 'lead' } });
    expect(spec.hostTools).toBeUndefined();
  });

  it('skips a non-leader teammate with no leader label', () => {
    const wrapped = withTeamModeHostTools(stubResolve() as never, {
      a8sUrl: 'http://a8s', adminToken: 't', logger: { log() {}, warn() {}, error() {} },
    });
    const spec = wrapped({ agentId: 'tm', workspace: 'tm', projectRoot: PROJECT, model: 'tier:strong', labels: { team: 'true' } });
    expect(spec.hostTools).toBeUndefined();
  });
});

describe('withTeamModeHostTools — toolset by label', () => {
  function toolNames(labels: Record<string, string>): string[] {
    const wrapped = withTeamModeHostTools(stubResolve() as never, { a8sUrl: 'http://a8s', adminToken: 't' });
    const spec = wrapped({ agentId: labels.role === 'leader' ? 'lead' : 'tm', workspace: 'w', projectRoot: PROJECT, model: 'tier:strong', labels });
    return (spec.hostTools ?? []).map((t) => t.definition.name);
  }

  it('teammate gets shared + report-up tools, not command tools', () => {
    const names = toolNames({ team: 'true', leader: 'lead', role: 'reviewer' });
    expect(names).toEqual(expect.arrayContaining([
      'read_worklist', 'read_inbox', 'post_message', 'message_leader', 'claim_task', 'update_task',
    ]));
    expect(names).not.toContain('spawn_teammate');
    expect(names).not.toContain('disband_teammate');
  });

  it('leader (role:leader) gets shared + command tools, not the teammate loop', () => {
    const names = toolNames({ team: 'true', role: 'leader' });
    expect(names).toEqual(expect.arrayContaining([
      'read_worklist', 'read_inbox', 'post_message',
      'spawn_teammate', 'message_teammate', 'list_team', 'disband_teammate', 'worklist_add',
    ]));
    expect(names).not.toContain('message_leader');
    expect(names).not.toContain('claim_task');
  });

  it('an agent whose leader label points at itself is treated as leader', () => {
    const wrapped = withTeamModeHostTools(stubResolve() as never, { a8sUrl: 'http://a8s', adminToken: 't' });
    const spec = wrapped({ agentId: 'boss', workspace: 'w', projectRoot: PROJECT, model: 'tier:strong', labels: { team: 'true', leader: 'boss' } });
    const names = (spec.hostTools ?? []).map((t) => t.definition.name);
    expect(names).toContain('spawn_teammate');
  });

  it('host-supplied hostTools win on name conflict', () => {
    const custom = {
      definition: { name: 'read_worklist', description: 'custom', inputSchema: { type: 'object' as const, properties: {} } },
      execute: async () => ({ content: 'custom' }),
    };
    const baseResolve = ((wire: { agentId: string; workspace: string; projectRoot?: string; model: string }) => ({
      agentId: wire.agentId, workspace: `/tmp/${wire.agentId}`, projectRoot: wire.projectRoot,
      home: new AgentHome(`/tmp/${wire.agentId}`), model: wire.model, ensureDefaultMcpConfig: false,
      hostTools: [custom],
    })) as never;
    const wrapped = withTeamModeHostTools(baseResolve, { a8sUrl: 'http://a8s', adminToken: 't' });
    const spec = wrapped({ agentId: 'tm', workspace: 'tm', projectRoot: PROJECT, model: 'tier:strong', labels: { team: 'true', leader: 'lead' } });
    const tools = (spec.hostTools ?? []).filter((t) => t.definition.name === 'read_worklist');
    expect(tools).toHaveLength(1);
    expect(tools[0]).toBe(custom);
  });
});

describe('withTeamModeHostTools — teammate tool behavior', () => {
  function teammate(fetchImpl: typeof fetch) {
    const wrapped = withTeamModeHostTools(stubResolve() as never, { a8sUrl: 'http://a8s', adminToken: 'tok', fetch: fetchImpl });
    const spec = wrapped({ agentId: 'reviewer', workspace: 'reviewer', projectRoot: PROJECT, model: 'tier:strong', labels: { team: 'true', leader: 'coder' } });
    return (name: string) => (spec.hostTools ?? []).find((t) => t.definition.name === name)!;
  }

  it('message_leader appends a message AND schedules a wake', async () => {
    const { fetch, calls } = recordingFetch([
      { match: '/messages', body: { id: 'm1', ts: 1, from: 'reviewer', to: 'coder', content: 'done' } },
      { match: '/wakes/schedule', body: { wakeId: 'w1', dueAt: 0 } },
    ]);
    const tool = teammate(fetch)('message_leader');
    const res = await tool.execute({ content: 'done with review' }, { cwd: '/tmp' });
    expect(res.isError).not.toBe(true);
    const msg = calls.find((c) => c.url.includes('/messages'))!;
    expect(msg.method).toBe('POST');
    expect(msg.body).toMatchObject({ from: 'reviewer', to: 'coder', content: 'done with review' });
    const wake = calls.find((c) => c.url.includes('/wakes/schedule'))!;
    expect(wake.body).toMatchObject({ agentId: 'coder', reason: 'teammate_message' });
  });

  it('claim_task PATCHes the task to claimed + self assignee', async () => {
    const { fetch, calls } = recordingFetch([
      { match: '/worklist/', body: { id: 't1', title: 'wire login', status: 'claimed', assignee: 'reviewer', createdBy: 'coder', createdAt: 1, updatedAt: 2 } },
    ]);
    const tool = teammate(fetch)('claim_task');
    const res = await tool.execute({ taskId: 't1' }, { cwd: '/tmp' });
    expect(res.isError).not.toBe(true);
    const patch = calls.find((c) => c.method === 'PATCH')!;
    expect(patch.url).toContain('/worklist/t1');
    expect(patch.body).toMatchObject({ status: 'claimed', assignee: 'reviewer' });
  });

  it('update_task requires failureReason when failing', async () => {
    const { fetch } = recordingFetch([]);
    const tool = teammate(fetch)('update_task');
    const res = await tool.execute({ taskId: 't1', status: 'failed' }, { cwd: '/tmp' });
    expect(res.isError).toBe(true);
    expect(res.content).toMatch(/failureReason/);
  });

  it('read_inbox filters to messages addressed to self or broadcast', async () => {
    const { fetch } = recordingFetch([
      { match: '/messages', body: { messages: [
        { id: 'm1', ts: 1, from: 'coder', to: 'reviewer', content: 'for you' },
        { id: 'm2', ts: 2, from: 'coder', to: 'someone-else', content: 'not yours' },
        { id: 'm3', ts: 3, from: 'coder', to: '@broadcast', content: 'all hands' },
      ] } },
    ]);
    const tool = teammate(fetch)('read_inbox');
    const res = await tool.execute({}, { cwd: '/tmp' });
    expect(res.content).toContain('for you');
    expect(res.content).toContain('all hands');
    expect(res.content).not.toContain('not yours');
  });

  it('surfaces HTTP errors as isError', async () => {
    const { fetch } = recordingFetch([{ match: '/messages', status: 500, body: { error: { code: 'boom', message: 'broke' } } }]);
    const tool = teammate(fetch)('message_leader');
    const res = await tool.execute({ content: 'hi' }, { cwd: '/tmp' });
    expect(res.isError).toBe(true);
    expect(res.content).toMatch(/HTTP 500/);
  });
});

describe('withTeamModeHostTools — leader tool behavior', () => {
  function leader(fetchImpl: typeof fetch, opts: { randomSuffix?: () => string } = {}) {
    const wrapped = withTeamModeHostTools(stubResolve() as never, {
      a8sUrl: 'http://a8s', adminToken: 'tok', fetch: fetchImpl, randomSuffix: opts.randomSuffix,
    });
    const spec = wrapped({ agentId: 'lead', workspace: 'lead', projectRoot: PROJECT, model: 'tier:strong', labels: { team: 'true', role: 'leader' } });
    return (name: string) => (spec.hostTools ?? []).find((t) => t.definition.name === name)!;
  }

  it('spawn_teammate POSTs a create-agent request with team labels + entry', async () => {
    const { fetch, calls } = recordingFetch([
      { match: '/v1/agents', body: { agentId: 'reviewer-zzz', workerId: 'w-1', leaseId: 'l-1' } },
    ]);
    const tool = leader(fetch, { randomSuffix: () => 'zzz' })('spawn_teammate');
    const res = await tool.execute({ role: 'reviewer', systemPrompt: 'Review all diffs.' }, { cwd: '/tmp' });
    expect(res.isError).not.toBe(true);
    expect(res.content).toContain('reviewer-zzz');
    const create = calls.find((c) => c.method === 'POST')!;
    expect(create.body).toMatchObject({
      spec: { agentId: 'reviewer-zzz', projectRoot: PROJECT, labels: { team: 'true', role: 'reviewer', leader: 'lead', project: PROJECT } },
      entry: { role: 'reviewer', systemPrompt: 'Review all diffs.', leaderId: 'lead' },
    });
  });

  it('message_teammate posts + wakes the named teammate', async () => {
    const { fetch, calls } = recordingFetch([
      { match: '/messages', body: { id: 'm1', ts: 1, from: 'lead', to: 'reviewer-1', content: 'go' } },
      { match: '/wakes/schedule', body: { wakeId: 'w1', dueAt: 0 } },
    ]);
    const tool = leader(fetch)('message_teammate');
    await tool.execute({ to: 'reviewer-1', content: 'start now' }, { cwd: '/tmp' });
    const wake = calls.find((c) => c.url.includes('/wakes/schedule'))!;
    expect(wake.body).toMatchObject({ agentId: 'reviewer-1', reason: 'leader_message' });
  });

  it('list_team filters cluster agents to this project + team', async () => {
    const { fetch } = recordingFetch([
      { match: '/v1/agents', body: { agents: [
        { agentId: 'lead', workerId: 'w1', labels: { team: 'true', role: 'leader', project: PROJECT } },
        { agentId: 'reviewer-1', workerId: 'w2', labels: { team: 'true', role: 'reviewer', project: PROJECT } },
        { agentId: 'stranger', workerId: 'w3', labels: { team: 'true', role: 'x', project: '/other' } },
        { agentId: 'solo', workerId: 'w4', labels: {} },
      ] } },
    ]);
    const tool = leader(fetch)('list_team');
    const res = await tool.execute({}, { cwd: '/tmp' });
    expect(res.content).toContain('lead');
    expect(res.content).toContain('reviewer-1');
    expect(res.content).not.toContain('stranger');
    expect(res.content).not.toContain('solo');
  });

  it('disband_teammate refuses to delete the leader itself', async () => {
    const { fetch, calls } = recordingFetch([]);
    const tool = leader(fetch)('disband_teammate');
    const res = await tool.execute({ agentId: 'lead' }, { cwd: '/tmp' });
    expect(res.isError).toBe(true);
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
  });

  it('disband_teammate DELETEs a teammate agent', async () => {
    const { fetch, calls } = recordingFetch([{ match: '/v1/agents/reviewer-1', body: {} }]);
    const tool = leader(fetch)('disband_teammate');
    const res = await tool.execute({ agentId: 'reviewer-1' }, { cwd: '/tmp' });
    expect(res.isError).not.toBe(true);
    const del = calls.find((c) => c.method === 'DELETE')!;
    expect(del.url).toContain('/v1/agents/reviewer-1');
  });

  it('worklist_add POSTs a task stamped with the leader as createdBy', async () => {
    const { fetch, calls } = recordingFetch([
      { match: '/worklist', body: { id: 't1', title: 'wire login', status: 'unclaimed', createdBy: 'lead', createdAt: 1, updatedAt: 1 } },
    ]);
    const tool = leader(fetch)('worklist_add');
    await tool.execute({ title: 'wire login', description: 'with validation' }, { cwd: '/tmp' });
    const post = calls.find((c) => c.method === 'POST')!;
    expect(post.body).toMatchObject({ title: 'wire login', description: 'with validation', createdBy: 'lead' });
  });
});
