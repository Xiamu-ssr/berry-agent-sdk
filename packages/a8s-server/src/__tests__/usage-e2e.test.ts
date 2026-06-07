// ============================================================
// E2E: usage / consumption rollup over real HTTP
// ============================================================
// Verifies the read-only consumption path end to end:
//   worker-daemon GET /v1/agents/:id/usage  (from injected usage resolver)
//   a8s-server    GET /v1/agents/:id/usage   (proxy to owning worker)
//   a8s-server    GET /v1/operator/usage      (fan-in + upward aggregation)
//
// a8s holds NO usage state — it only proxies each agent's rollup and sums
// upward into cluster totals. We inject a deterministic usage resolver into
// the worker daemon so the numbers are exact, then assert the wire
// round-trips and the aggregation math is correct. Agents are created with
// the admin token (unowned), so per-product subtotals roll into "(unowned)".

import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  A8S_PATHS,
  agentUsageResponseSchema,
  operatorUsageResponseSchema,
  createAgentRequestSchema,
  createAgentResponseSchema,
  type AgentUsage,
} from '@berry-agent/cluster-protocol';
import { AgentHome } from '@berry-agent/core';
import {
  MemoryRuntimeOrchestrationStore,
  RuntimeOrchestrator,
} from '@berry-agent/runtime';
import { Worker } from '@berry-agent/worker';
import { makeTestWorkerEnv } from '@berry-agent/worker/test-utils';
import {
  WorkerDaemon,
  WorkerRegistrationClient,
} from '@berry-agent/worker-daemon';
import { A8sServer } from '../server.js';

interface TestEntry { tag: string }

async function pickPort(): Promise<number> {
  const net = await import('node:net');
  return await new Promise<number>((resolve) => {
    const s = net.createServer();
    s.unref();
    s.listen(0, () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

function fakeUsage(agentId: string, over: Partial<AgentUsage> = {}): AgentUsage {
  return {
    agentId,
    sessionCount: 2,
    totalCost: 1.5,
    totalTokens: 1000,
    avgSessionCost: 0.75,
    topTools: [{ name: 'bash', count: 3 }],
    modelUsage: { 'claude-x': 5 },
    ...over,
  };
}

describe('a8s usage rollup E2E', () => {
  it('proxies per-agent usage and fans-in operator cluster totals', async () => {
    // ---- a8s-server (admin token so /operator/usage is reachable) ----
    const orchestrator = new RuntimeOrchestrator({ store: new MemoryRuntimeOrchestrationStore() });
    const adminToken = 'admin-usage-test';
    const a8s = new A8sServer<TestEntry>({
      port: await pickPort(),
      adminToken,
      controlPlane: { orchestrator },
    });
    const a8sInfo = await a8s.start();

    // ---- worker daemon with a deterministic usage resolver ----
    const root = mkdtempSync(join(tmpdir(), 'wd-usage-'));
    const worker = new Worker<TestEntry>({ env: makeTestWorkerEnv(root) });
    const KNOWN: Record<string, AgentUsage> = {};
    const daemon = new WorkerDaemon<TestEntry>({
      worker,
      workerId: 'wd-usage',
      port: await pickPort(),
      bindHost: '127.0.0.1',
      resolveSpec: (wire) => ({
        agentId: wire.agentId,
        workspace: join(root, 'agents', wire.agentId),
        home: new AgentHome(join(root, 'agents', wire.agentId)),
        projectRoot: wire.projectRoot,
        model: wire.model,
        ensureDefaultMcpConfig: false,
      }),
      usage: (agentId) => KNOWN[agentId] ?? null,
    });
    const dInfo = await daemon.start();
    const reg = new WorkerRegistrationClient({
      a8sUrl: a8sInfo.url,
      workerId: 'wd-usage',
      callbackUrl: dInfo.callbackUrl,
      capacity: 4,
      heartbeatTtlMs: 30_000,
      adminToken,
    });
    daemon.setAuthToken((await reg.register()).workerToken);

    const admin = { authorization: `Bearer ${adminToken}` };

    // ---- create three agents (admin → unowned) ----
    async function createAgent(agentId: string) {
      const res = await fetch(`${a8sInfo.url}${A8S_PATHS.agents}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...admin },
        body: JSON.stringify(createAgentRequestSchema.parse({
          spec: { agentId, workspace: agentId, model: 'tier:strong', ensureDefaultMcpConfig: false },
          entry: { tag: 'usage' },
        })),
      });
      expect(res.status).toBe(200);
      createAgentResponseSchema.parse(await res.json());
    }
    await createAgent('alpha');
    await createAgent('beta');
    await createAgent('gamma');

    // Record usage for two of the three; gamma stays unrecorded (null).
    KNOWN['alpha'] = fakeUsage('alpha', { totalCost: 2, totalTokens: 1200, sessionCount: 3 });
    KNOWN['beta'] = fakeUsage('beta', { totalCost: 1, totalTokens: 800, sessionCount: 1 });

    // ---- per-agent proxy: recorded agent ----
    const alphaRes = await fetch(`${a8sInfo.url}${A8S_PATHS.agentUsage('alpha')}`, { headers: admin });
    expect(alphaRes.status).toBe(200);
    const alpha = agentUsageResponseSchema.parse(await alphaRes.json());
    expect(alpha.present).toBe(true);
    expect(alpha.usage?.totalCost).toBe(2);
    expect(alpha.usage?.agentId).toBe('alpha');

    // ---- per-agent proxy: agent with no recorded usage ----
    const gammaRes = await fetch(`${a8sInfo.url}${A8S_PATHS.agentUsage('gamma')}`, { headers: admin });
    expect(gammaRes.status).toBe(200);
    const gamma = agentUsageResponseSchema.parse(await gammaRes.json());
    expect(gamma.present).toBe(false);
    expect(gamma.usage).toBeNull();

    // ---- operator fan-in: cluster totals (gamma contributes nothing) ----
    const opRes = await fetch(`${a8sInfo.url}${A8S_PATHS.operatorUsage}`, { headers: admin });
    expect(opRes.status).toBe(200);
    const op = operatorUsageResponseSchema.parse(await opRes.json());

    expect(op.totals.agentCount).toBe(2);
    expect(op.totals.totalCost).toBeCloseTo(3, 6);
    expect(op.totals.totalTokens).toBe(2000);
    expect(op.totals.sessionCount).toBe(4);

    // Both recorded agents are unowned → a single "(unowned)" product bucket.
    const unowned = op.byProduct.find((p) => p.product === '(unowned)');
    expect(unowned).toBeTruthy();
    expect(unowned!.agentCount).toBe(2);
    expect(unowned!.totalCost).toBeCloseTo(3, 6);

    // The per-agent rows echo what each worker reported.
    expect(op.agents.map((a) => a.agentId).sort()).toEqual(['alpha', 'beta']);

    await reg.withdraw(true).catch(() => {});
    await daemon.stop();
    await worker.dispose();
    await a8s.stop();
  });
});
