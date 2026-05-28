// ============================================================
// @berry-agent/a8s-admin — unit tests
// ============================================================
// We don't spin up a real a8s here — the e2e test in a8s-server already
// covers that. These tests focus on: hand wires tools correctly, parses
// the operator schemas, and surfaces errors as ToolResult.isError.

import { describe, expect, it } from 'vitest';
import { A8sOperatorClient } from '../operator-client.js';
import { createClusterAdminHand } from '../cluster-admin-hand.js';

function stubFetch(handler: (url: string, init: RequestInit | undefined) => Response | Promise<Response>): typeof fetch {
  return (async (input: Request | string | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    return handler(url, init);
  }) as unknown as typeof fetch;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('A8sOperatorClient', () => {
  it('sends bearer admin token + parses cluster report', async () => {
    let seenAuth = '';
    const fetchImpl = stubFetch((_url, init) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      seenAuth = headers.Authorization ?? headers.authorization ?? '';
      return jsonResponse(200, {
        workerCount: { total: 2, active: 1, draining: 1, evicted: 0 },
        capacity: { total: 8, used: 3, available: 5 },
        agentCount: 3,
        uptimeSeconds: 42,
      });
    });
    const client = new A8sOperatorClient({
      a8sUrl: 'http://test',
      adminToken: 'top-secret',
      fetch: fetchImpl,
    });
    const report = await client.clusterReport();
    expect(seenAuth).toBe('Bearer top-secret');
    expect(report.workerCount.total).toBe(2);
    expect(report.capacity.available).toBe(5);
  });

  it('throws with HTTP context on non-2xx', async () => {
    const fetchImpl = stubFetch(() => jsonResponse(401, { error: { code: 'unauthorized', message: 'no token' } }));
    const client = new A8sOperatorClient({
      a8sUrl: 'http://test',
      adminToken: 'bad',
      fetch: fetchImpl,
    });
    await expect(client.clusterReport()).rejects.toThrow(/HTTP 401/);
  });

  it('drainWorker POSTs with empty json body', async () => {
    let seenMethod = '';
    let seenBody: unknown = null;
    const fetchImpl = stubFetch((_url, init) => {
      seenMethod = init?.method ?? '';
      seenBody = init?.body;
      return jsonResponse(200, { ok: true });
    });
    const client = new A8sOperatorClient({ a8sUrl: 'http://test', adminToken: 'x', fetch: fetchImpl });
    await client.drainWorker('worker-1');
    expect(seenMethod).toBe('POST');
    expect(seenBody).toBe('{}');
  });
});

describe('createClusterAdminHand', () => {
  it('exposes the expected capability set', () => {
    const client = new A8sOperatorClient({ a8sUrl: 'http://test', adminToken: 'x' });
    const hand = createClusterAdminHand({ client });
    const names = hand.capabilities().map((c) => c.definition.name).sort();
    expect(names).toEqual([
      'cluster_report',
      'drain_worker',
      'evict_worker',
      'list_agents',
      'list_leases',
      'list_workers',
      'undrain_worker',
      'worker_join_script',
    ]);
  });

  it('list_workers tool returns JSON payload from the client', async () => {
    const fetchImpl = stubFetch(() =>
      jsonResponse(200, {
        workers: [
          {
            workerId: 'w1',
            state: 'active',
            capacity: 4,
            used: 1,
            callbackUrl: 'http://w1:7100',
            registeredAt: 1,
            heartbeatAt: 2,
            heartbeatExpiresAt: 30000,
          },
        ],
      }),
    );
    const client = new A8sOperatorClient({ a8sUrl: 'http://test', adminToken: 'x', fetch: fetchImpl });
    const hand = createClusterAdminHand({ client });
    const tool = hand.capabilities().find((c) => c.definition.name === 'list_workers')!;
    const result = await hand.execute(
      { capabilityId: tool.id, input: {} },
      { cwd: '/tmp', handId: 'cluster-admin', handKind: 'local', capability: tool },
    );
    expect(result.isError).not.toBe(true);
    const parsed = JSON.parse(result.content);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].workerId).toBe('w1');
  });

  it('drain_worker tool reports missing workerId as isError', async () => {
    const client = new A8sOperatorClient({ a8sUrl: 'http://test', adminToken: 'x' });
    const hand = createClusterAdminHand({ client });
    const tool = hand.capabilities().find((c) => c.definition.name === 'drain_worker')!;
    const result = await hand.execute(
      { capabilityId: tool.id, input: { workerId: '' } },
      { cwd: '/tmp', handId: 'cluster-admin', handKind: 'local', capability: tool },
    );
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/required/);
  });
});
