// ============================================================
// E2E: a8s-server + worker-daemon over real HTTP
// ============================================================
// Spins up a real a8s-server + 2 worker daemons on random ports, has
// each daemon register over HTTP, then creates an agent and asserts that
// it was actually mounted on one of the workers. No mocks for the
// HTTP layer — verifies the wire protocol round-trips correctly.

import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AddressInfo } from 'node:net';
import {
  A8S_PATHS,
  createAgentRequestSchema,
  createAgentResponseSchema,
  listAgentsResponseSchema,
  sessionEventsResponseSchema,
  sessionListResponseSchema,
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
  // Cheap port picker: open a server on 0, read the assigned port, close.
  const net = await import('node:net');
  return await new Promise<number>((resolve) => {
    const s = net.createServer();
    s.listen(0, () => {
      const port = (s.address() as AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

describe('a8s-server + worker-daemon E2E', () => {
  it('two worker daemons register and a8s schedules an agent on one of them', async () => {
    // ---- a8s-server ----
    const orchestrator = new RuntimeOrchestrator({
      store: new MemoryRuntimeOrchestrationStore(),
    });
    const a8sPort = await pickPort();
    const a8s = new A8sServer<TestEntry>({
      port: a8sPort,
      controlPlane: { orchestrator },
    });
    const a8sInfo = await a8s.start();

    // ---- Worker 1 ----
    const root1 = mkdtempSync(join(tmpdir(), 'wd-e2e-1-'));
    const w1Port = await pickPort();
    const env1 = makeTestWorkerEnv(root1);
    const worker1 = new Worker<TestEntry>({ env: env1 });
    const daemon1 = new WorkerDaemon<TestEntry>({
      worker: worker1,
      workerId: 'wd-1',
      port: w1Port,
      bindHost: '127.0.0.1',
      resolveSpec: (wire) => ({
        agentId: wire.agentId,
        workspace: wire.workspace,
        home: new AgentHome(wire.workspace),
        projectRoot: wire.projectRoot,
        model: wire.model,
        ensureDefaultMcpConfig: false,
      }),
    });
    const d1Info = await daemon1.start();
    const reg1 = new WorkerRegistrationClient({
      a8sUrl: a8sInfo.url,
      workerId: 'wd-1',
      callbackUrl: d1Info.callbackUrl,
      capacity: 4,
      heartbeatTtlMs: 30_000,
    });
    const reg1Result = await reg1.register();
    daemon1.setAuthToken(reg1Result.workerToken);

    // ---- Worker 2 ----
    const root2 = mkdtempSync(join(tmpdir(), 'wd-e2e-2-'));
    const w2Port = await pickPort();
    const env2 = makeTestWorkerEnv(root2);
    const worker2 = new Worker<TestEntry>({ env: env2 });
    const daemon2 = new WorkerDaemon<TestEntry>({
      worker: worker2,
      workerId: 'wd-2',
      port: w2Port,
      bindHost: '127.0.0.1',
      resolveSpec: (wire) => ({
        agentId: wire.agentId,
        workspace: wire.workspace,
        home: new AgentHome(wire.workspace),
        projectRoot: wire.projectRoot,
        model: wire.model,
        ensureDefaultMcpConfig: false,
      }),
    });
    const d2Info = await daemon2.start();
    const reg2 = new WorkerRegistrationClient({
      a8sUrl: a8sInfo.url,
      workerId: 'wd-2',
      callbackUrl: d2Info.callbackUrl,
      capacity: 4,
      heartbeatTtlMs: 30_000,
    });
    const reg2Result = await reg2.register();
    daemon2.setAuthToken(reg2Result.workerToken);

    // ---- Product → a8s: create an agent ----
    const agentWorkspace = mkdtempSync(join(tmpdir(), 'wd-e2e-agent-'));
    const createBody = createAgentRequestSchema.parse({
      spec: {
        agentId: 'a-test',
        workspace: agentWorkspace,
        model: 'tier:strong',
        ensureDefaultMcpConfig: false,
      },
      entry: { tag: 'e2e' },
    });
    const createResp = await fetch(`${a8sInfo.url}${A8S_PATHS.agents}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(createBody),
    });
    expect(createResp.status).toBe(200);
    const createParsed = createAgentResponseSchema.parse(await createResp.json());
    expect(createParsed.agentId).toBe('a-test');
    expect(['wd-1', 'wd-2']).toContain(createParsed.workerId);

    // ---- Verify the agent really mounted on whichever worker was picked ----
    const picked = createParsed.workerId;
    const pickedWorker = picked === 'wd-1' ? worker1 : worker2;
    expect(pickedWorker.has('a-test')).toBe(true);
    const otherWorker = picked === 'wd-1' ? worker2 : worker1;
    expect(otherWorker.has('a-test')).toBe(false);

    // ---- Verify a8s listAgents reports the assignment ----
    const listResp = await fetch(`${a8sInfo.url}${A8S_PATHS.agents}`);
    expect(listResp.status).toBe(200);
    const list = listAgentsResponseSchema.parse(await listResp.json());
    expect(list.agents).toHaveLength(1);
    expect(list.agents[0].agentId).toBe('a-test');
    expect(list.agents[0].workerId).toBe(picked);

    // ---- Cleanup ----
    await reg1.withdraw(true);
    await reg2.withdraw(true);
    await daemon1.stop();
    await daemon2.stop();
    await worker1.dispose();
    await worker2.dispose();
    await a8s.stop();
  });

  it('rejects worker heartbeat with wrong token', async () => {
    const orchestrator = new RuntimeOrchestrator({
      store: new MemoryRuntimeOrchestrationStore(),
    });
    const a8sPort = await pickPort();
    const a8s = new A8sServer<TestEntry>({
      port: a8sPort,
      controlPlane: { orchestrator },
    });
    const a8sInfo = await a8s.start();

    // Register a worker, get a real token
    const registerResp = await fetch(`${a8sInfo.url}${A8S_PATHS.workersRegister}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        workerId: 'auth-test',
        callbackUrl: 'http://localhost:9999',
        capacity: 1,
        heartbeatTtlMs: 30_000,
      }),
    });
    expect(registerResp.status).toBe(200);

    // Heartbeat with WRONG token
    const heartbeatResp = await fetch(
      `${a8sInfo.url}${A8S_PATHS.workerHeartbeat('auth-test')}`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer not-the-real-token',
        },
        body: '{}',
      },
    );
    expect(heartbeatResp.status).toBe(401);

    await a8s.stop();
  });

  it('health endpoint works unauthenticated', async () => {
    const orchestrator = new RuntimeOrchestrator({
      store: new MemoryRuntimeOrchestrationStore(),
    });
    const a8sPort = await pickPort();
    const a8s = new A8sServer<TestEntry>({
      port: a8sPort,
      controlPlane: { orchestrator },
      version: '0.5.0-test',
    });
    const a8sInfo = await a8s.start();
    const resp = await fetch(`${a8sInfo.url}${A8S_PATHS.health}`);
    expect(resp.status).toBe(200);
    const body = await resp.json() as { ok: boolean; version: string };
    expect(body.ok).toBe(true);
    expect(body.version).toBe('0.5.0-test');
    await a8s.stop();
  });

  it('sessions list + paginated events round-trip through a8s → worker', async () => {
    const orchestrator = new RuntimeOrchestrator({
      store: new MemoryRuntimeOrchestrationStore(),
    });
    const a8sPort = await pickPort();
    const a8s = new A8sServer<TestEntry>({
      port: a8sPort,
      controlPlane: { orchestrator },
    });
    const a8sInfo = await a8s.start();

    const root = mkdtempSync(join(tmpdir(), 'wd-sess-'));
    const wPort = await pickPort();
    const env = makeTestWorkerEnv(root);
    const worker = new Worker<TestEntry>({ env });
    const daemon = new WorkerDaemon<TestEntry>({
      worker,
      workerId: 'wd-sess',
      port: wPort,
      bindHost: '127.0.0.1',
      resolveSpec: (wire) => ({
        agentId: wire.agentId,
        workspace: wire.workspace,
        home: new AgentHome(wire.workspace),
        projectRoot: wire.projectRoot,
        model: wire.model,
        ensureDefaultMcpConfig: false,
      }),
    });
    const dInfo = await daemon.start();
    const reg = new WorkerRegistrationClient({
      a8sUrl: a8sInfo.url,
      workerId: 'wd-sess',
      callbackUrl: dInfo.callbackUrl,
      capacity: 4,
      heartbeatTtlMs: 30_000,
    });
    const regResult = await reg.register();
    daemon.setAuthToken(regResult.workerToken);

    // Create the agent through a8s.
    const agentWorkspace = mkdtempSync(join(tmpdir(), 'wd-sess-agent-'));
    const createResp = await fetch(`${a8sInfo.url}${A8S_PATHS.agents}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(createAgentRequestSchema.parse({
        spec: {
          agentId: 'a-sess',
          workspace: agentWorkspace,
          model: 'tier:strong',
          ensureDefaultMcpConfig: false,
        },
        entry: { tag: 'sess' },
      })),
    });
    expect(createResp.status).toBe(200);

    // Drive a session into existence + seed deterministic events so we
    // don't need a real LLM. Direct-grab the local runtime since we're
    // colocated; the assertions below still exercise the full HTTP path.
    const mount = worker.get('a-sess');
    if (!mount) throw new Error('agent not mounted');
    const session = await mount.runtime.createSession();
    // createSession() emits a session_start event, so we start with 1
    // before our seeded metadata events. Total below = 1 + 7 = 8.
    const seedCount = 7;
    for (let i = 0; i < seedCount; i++) {
      await mount.runtime.appendSessionEvent(session.id, {
        type: 'metadata',
        key: 'seq',
        value: i,
      });
    }

    // ---- List sessions via a8s ----
    const listResp = await fetch(`${a8sInfo.url}${A8S_PATHS.agentSessions('a-sess')}`);
    expect(listResp.status).toBe(200);
    const list = sessionListResponseSchema.parse(await listResp.json());
    expect(list.sessions).toHaveLength(1);
    expect(list.sessions[0].id).toBe(session.id);

    // ---- Walk pages until we hit the start, asserting no duplicates ----
    const pageSize = 3;
    const seenIds = new Set<string>();
    const collected: Array<Record<string, unknown>> = [];
    let cursor: string | null = null;
    let pages = 0;
    while (true) {
      pages++;
      const qs = cursor ? `?limit=${pageSize}&before=${cursor}` : `?limit=${pageSize}`;
      const resp = await fetch(`${a8sInfo.url}${A8S_PATHS.agentSessionEvents('a-sess', session.id)}${qs}`);
      expect(resp.status).toBe(200);
      const page = sessionEventsResponseSchema.parse(await resp.json());
      // Pages contain at most pageSize events.
      expect(page.events.length).toBeLessThanOrEqual(pageSize);
      // Prepend so the final collected order is oldest → newest.
      for (let i = page.events.length - 1; i >= 0; i--) {
        const ev = page.events[i];
        const id = (ev as { id?: string }).id;
        expect(id).toBeDefined();
        expect(seenIds.has(id!)).toBe(false);
        seenIds.add(id!);
        collected.unshift(ev);
      }
      if (page.reachedStart) {
        expect(page.nextBefore).toBeNull();
        break;
      }
      expect(page.nextBefore).not.toBeNull();
      cursor = page.nextBefore;
      if (pages > 10) throw new Error('pagination did not terminate');
    }

    // Expect session_start + 7 seeded metadata events.
    expect(collected).toHaveLength(seedCount + 1);
    const types = collected.map((e) => (e as { type: string }).type);
    expect(types[0]).toBe('session_start');
    // The seeded metadata events appear in append order, oldest first.
    const seqValues = collected
      .filter((e) => (e as { type: string }).type === 'metadata')
      .map((e) => (e as { value: number }).value);
    expect(seqValues).toEqual([0, 1, 2, 3, 4, 5, 6]);

    await reg.withdraw(true);
    await daemon.stop();
    await worker.dispose();
    await a8s.stop();
  });
});
