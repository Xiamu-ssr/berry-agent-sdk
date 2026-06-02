// ============================================================
// @berry-agent/a8s-admin — berry-a8s-ops CLI tests
// ============================================================
// The operator's primary tool. main() is dependency-injected (client
// factory + output writers + env) so we exercise the full command surface
// without env, network, or process side-effects.

import { describe, expect, it } from 'vitest';
import { main, type OpsCliDeps } from '../ops-cli.js';

interface Captured { out: string; err: string; code: number }

function makeStubClient(overrides: Partial<Record<string, unknown>> = {}) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const rec = (method: string) => (...args: unknown[]) => {
    calls.push({ method, args });
    const fn = overrides[method];
    return Promise.resolve(typeof fn === 'function' ? (fn as (...a: unknown[]) => unknown)(...args) : fn);
  };
  const client = {
    clusterReport: rec('clusterReport'),
    listWorkers: rec('listWorkers'),
    listAgents: rec('listAgents'),
    listLeases: rec('listLeases'),
    listMachines: rec('listMachines'),
    drainWorker: rec('drainWorker'),
    undrainWorker: rec('undrainWorker'),
    evictWorker: rec('evictWorker'),
    joinScript: rec('joinScript'),
    machineJoinScript: rec('machineJoinScript'),
  };
  return { client, calls };
}

async function run(argv: string[], clientStub: ReturnType<typeof makeStubClient>['client'], env: Record<string, string> = { BERRY_A8S_ADMIN_TOKEN: 't' }): Promise<Captured> {
  let out = ''; let err = '';
  const deps: OpsCliDeps = {
    makeClient: () => clientStub as never,
    stdout: (s) => { out += s; },
    stderr: (s) => { err += s; },
    env,
  };
  const code = await main(argv, deps);
  return { out, err, code };
}

describe('berry-a8s-ops main()', () => {
  it('prints usage and exits 2 with no args, 0 with --help', async () => {
    const { client } = makeStubClient();
    const noArgs = await run([], client);
    expect(noArgs.code).toBe(2);
    expect(noArgs.out).toContain('berry-a8s-ops');
    const help = await run(['--help'], client);
    expect(help.code).toBe(0);
  });

  it('exits 2 when no token is available', async () => {
    const { client } = makeStubClient();
    const r = await run(['cluster'], client, {});
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/no admin token/);
  });

  it('cluster: prints a human summary', async () => {
    const { client, calls } = makeStubClient({
      clusterReport: {
        workerCount: { active: 1, total: 2, draining: 1, evicted: 0 },
        capacity: { used: 3, total: 8, available: 5 },
        agentCount: 4, uptimeSeconds: 42,
      },
    });
    const r = await run(['cluster'], client);
    expect(r.code).toBe(0);
    expect(calls[0].method).toBe('clusterReport');
    expect(r.out).toContain('1 active / 2 total');
    expect(r.out).toContain('3/8 used');
  });

  it('--json: prints raw JSON instead of the summary', async () => {
    const report = {
      workerCount: { active: 1, total: 1, draining: 0, evicted: 0 },
      capacity: { used: 0, total: 8, available: 8 },
      agentCount: 0, uptimeSeconds: 1,
    };
    const { client } = makeStubClient({ clusterReport: report });
    const r = await run(['cluster', '--json'], client);
    expect(JSON.parse(r.out)).toEqual(report);
  });

  it('workers: tab-separated rows, or empty marker', async () => {
    const { client } = makeStubClient({ listWorkers: { workers: [] } });
    const empty = await run(['workers'], client);
    expect(empty.out).toContain('(no workers registered)');

    const { client: c2 } = makeStubClient({
      listWorkers: { workers: [{ workerId: 'w1', state: 'active', used: 1, capacity: 4, labels: { machine: 'cloud-1' } }] },
    });
    const r = await run(['workers'], c2);
    expect(r.out).toContain('w1\tactive\t1/4\tmachine=cloud-1');
  });

  it('drain/undrain/evict: call the client with the workerId', async () => {
    const { client, calls } = makeStubClient({ drainWorker: undefined });
    const r = await run(['drain', 'w-b'], client);
    expect(r.code).toBe(0);
    expect(calls[0]).toEqual({ method: 'drainWorker', args: ['w-b'] });
    expect(r.out).toContain('worker "w-b" drained');
  });

  it('drain without a workerId exits 2', async () => {
    const { client } = makeStubClient();
    const r = await run(['drain'], client);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/needs a <workerId>/);
  });

  it('join-script: prints the script verbatim', async () => {
    const { client } = makeStubClient({ joinScript: { script: '#!/bin/bash\necho join', resolved: {} } });
    const r = await run(['join-script'], client);
    expect(r.out).toContain('echo join');
  });

  it('unknown command exits 2 with usage', async () => {
    const { client } = makeStubClient();
    const r = await run(['frobnicate'], client);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/unknown command: frobnicate/);
  });

  it('surfaces client errors as exit 1', async () => {
    const { client } = makeStubClient({
      clusterReport: () => { throw new Error('upstream down'); },
    });
    const r = await run(['cluster'], client);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/cluster failed: upstream down/);
  });
});
