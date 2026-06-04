// ============================================================
// @berry-agent/a8s-admin — berry-team CLI tests
// ============================================================
// The agent's collaboration tool. main() is dependency-injected (client
// factory + output writers + env) so we exercise the full command surface
// without env, network, or process side-effects.

import { describe, expect, it } from 'vitest';
import { main, type TeamCliDeps } from '../team-cli.js';

function makeStubClient(overrides: Record<string, unknown> = {}) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const rec = (method: string) => (...args: unknown[]) => {
    calls.push({ method, args });
    const fn = overrides[method];
    return Promise.resolve(typeof fn === 'function' ? (fn as (...a: unknown[]) => unknown)(...args) : fn);
  };
  const client = {
    listAgents: rec('listAgents'),
    createAgent: rec('createAgent'),
    sendToAgent: rec('sendToAgent'),
    agentSnapshot: rec('agentSnapshot'),
    deleteAgent: rec('deleteAgent'),
  };
  return { client, calls };
}

interface Captured { out: string; err: string; code: number }
async function run(
  argv: string[],
  client: ReturnType<typeof makeStubClient>['client'],
  env: Record<string, string> = { BERRY_A8S_ADMIN_TOKEN: 't' },
): Promise<Captured> {
  let out = ''; let err = '';
  const deps: TeamCliDeps = {
    makeClient: () => client as never,
    stdout: (s) => { out += s; },
    stderr: (s) => { err += s; },
    env,
  };
  const code = await main(argv, deps);
  return { out, err, code };
}

describe('berry-team main()', () => {
  it('usage: exit 2 no args, 0 with --help', async () => {
    const { client } = makeStubClient();
    expect((await run([], client)).code).toBe(2);
    expect((await run(['--help'], client)).code).toBe(0);
    expect((await run(['--help'], client)).out).toContain('berry-team');
  });

  it('requires a token', async () => {
    const { client } = makeStubClient();
    const r = await run(['peers'], client, {});
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/token/);
  });

  it('peers lists cluster agents', async () => {
    const { client, calls } = makeStubClient({
      listAgents: { agents: [{ agentId: 'lead', workerId: 'w1' }, { agentId: 'rev', workerId: 'w2' }] },
    });
    const r = await run(['peers'], client);
    expect(r.code).toBe(0);
    expect(r.out).toContain('lead');
    expect(r.out).toContain('rev');
    expect(calls.map((c) => c.method)).toEqual(['listAgents']);
  });

  it('spawn creates an agent with model + labels', async () => {
    const { client, calls } = makeStubClient({ createAgent: { agentId: 'rev', workerId: 'w2', leaseId: 'l1' } });
    const r = await run(
      ['spawn', 'rev', '--model', 'tier:strong', '--label', 'team=demo', '--label', 'role=reviewer'],
      client,
    );
    expect(r.code).toBe(0);
    expect(r.out).toContain('spawned "rev"');
    const arg = calls[0].args[0] as { spec: { agentId: string; model: string; labels: Record<string, string> } };
    expect(arg.spec.agentId).toBe('rev');
    expect(arg.spec.model).toBe('tier:strong');
    expect(arg.spec.labels).toEqual({ team: 'demo', role: 'reviewer' });
  });

  it('spawn rejects missing model', async () => {
    const { client } = makeStubClient();
    const r = await run(['spawn', 'rev'], client);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/model/);
  });

  it('send delivers a message and prints the reply', async () => {
    const { client, calls } = makeStubClient({
      sendToAgent: { sessionId: 's1', result: { assistantMessage: { content: 'done reviewing' } } },
    });
    const r = await run(['send', 'rev', 'review', 'the', 'diff'], client);
    expect(r.code).toBe(0);
    expect(r.out).toContain('done reviewing');
    expect(calls[0].args[0]).toBe('rev');
    expect((calls[0].args[1] as { prompt: string }).prompt).toBe('review the diff');
  });

  it('status reports model/hands/skills', async () => {
    const { client } = makeStubClient({
      agentSnapshot: { model: 'tier:strong', provider: 'anthropic', status: 'idle', hands: [{ id: 'workspace', kind: 'local', capabilities: ['shell'] }], skills: [{ name: 'team', description: 'x' }], tools: ['shell'] },
    });
    const r = await run(['status', 'rev'], client);
    expect(r.code).toBe(0);
    expect(r.out).toContain('workspace');
    expect(r.out).toContain('team');
  });

  it('disband deletes the agent', async () => {
    const { client, calls } = makeStubClient({ deleteAgent: undefined });
    const r = await run(['disband', 'rev'], client);
    expect(r.code).toBe(0);
    expect(calls[0].method).toBe('deleteAgent');
    expect(calls[0].args[0]).toBe('rev');
  });

  it('unknown command exits 2', async () => {
    const { client } = makeStubClient();
    expect((await run(['frobnicate'], client)).code).toBe(2);
  });
});
