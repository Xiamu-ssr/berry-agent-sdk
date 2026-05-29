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
  operatorClusterReportSchema,
  operatorLeaseListResponseSchema,
  operatorWorkerListResponseSchema,
  sessionEventsResponseSchema,
  sessionListResponseSchema,
  SSE_LAST_EVENT_ID_HEADER,
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
import { ensureAdminAgent, ensureLocalWorker } from '../bootstrap.js';

interface TestEntry { tag: string }

async function pickPort(): Promise<number> {
  // Cheap port picker: open a server on 0, read the assigned port, close.
  // We bind to all interfaces (matching how A8sServer / WorkerDaemon bind)
  // so the port we probe matches the one they'll subsequently grab.
  const net = await import('node:net');
  return await new Promise<number>((resolve) => {
    const s = net.createServer();
    s.unref();
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

  it('admin token gates product endpoints; workers can still join with it as bootstrap', async () => {
    const orchestrator = new RuntimeOrchestrator({
      store: new MemoryRuntimeOrchestrationStore(),
    });
    const a8sPort = await pickPort();
    const a8s = new A8sServer<TestEntry>({
      port: a8sPort,
      controlPlane: { orchestrator },
      adminToken: 'admin-secret',
    });
    const a8sInfo = await a8s.start();

    // ---- Product calls without token: 401 ----
    const noAuth = await fetch(`${a8sInfo.url}${A8S_PATHS.agents}`);
    expect(noAuth.status).toBe(401);

    // ---- Wrong token: 401 ----
    const wrongAuth = await fetch(`${a8sInfo.url}${A8S_PATHS.agents}`, {
      headers: { authorization: 'Bearer not-the-secret' },
    });
    expect(wrongAuth.status).toBe(401);

    // ---- Correct token: 200 ----
    const ok = await fetch(`${a8sInfo.url}${A8S_PATHS.agents}`, {
      headers: { authorization: 'Bearer admin-secret' },
    });
    expect(ok.status).toBe(200);

    // ---- Worker register without admin token: 401 ----
    const badRegister = await fetch(`${a8sInfo.url}${A8S_PATHS.workersRegister}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        workerId: 'rejected',
        callbackUrl: 'http://localhost:9999',
        capacity: 1,
        heartbeatTtlMs: 30_000,
      }),
    });
    expect(badRegister.status).toBe(401);

    // ---- Worker with bootstrap admin token can join ----
    const root = mkdtempSync(join(tmpdir(), 'wd-auth-'));
    const wPort = await pickPort();
    const env = makeTestWorkerEnv(root);
    const worker = new Worker<TestEntry>({ env });
    const daemon = new WorkerDaemon<TestEntry>({
      worker,
      workerId: 'wd-auth',
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
      workerId: 'wd-auth',
      callbackUrl: dInfo.callbackUrl,
      capacity: 4,
      heartbeatTtlMs: 30_000,
      adminToken: 'admin-secret',
    });
    const regResult = await reg.register();
    daemon.setAuthToken(regResult.workerToken);
    // Heartbeat (which now uses the per-worker token) still works.
    // We don't directly hit /heartbeat here — register() starts the loop
    // and listAgents below proves the registration took.
    const listAgents = await fetch(`${a8sInfo.url}${A8S_PATHS.agents}`, {
      headers: { authorization: 'Bearer admin-secret' },
    });
    expect(listAgents.status).toBe(200);

    await reg.withdraw(true);
    await daemon.stop();
    await worker.dispose();
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

  it('SSE event stream replays history then forwards live events', async () => {
    const orchestrator = new RuntimeOrchestrator({
      store: new MemoryRuntimeOrchestrationStore(),
    });
    const a8sPort = await pickPort();
    const a8s = new A8sServer<TestEntry>({
      port: a8sPort,
      controlPlane: { orchestrator },
    });
    const a8sInfo = await a8s.start();

    const root = mkdtempSync(join(tmpdir(), 'wd-sse-'));
    const wPort = await pickPort();
    const env = makeTestWorkerEnv(root);
    const worker = new Worker<TestEntry>({ env });
    const daemon = new WorkerDaemon<TestEntry>({
      worker,
      workerId: 'wd-sse',
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
      workerId: 'wd-sse',
      callbackUrl: dInfo.callbackUrl,
      capacity: 4,
      heartbeatTtlMs: 30_000,
    });
    const regResult = await reg.register();
    daemon.setAuthToken(regResult.workerToken);

    const agentWorkspace = mkdtempSync(join(tmpdir(), 'wd-sse-agent-'));
    const createResp = await fetch(`${a8sInfo.url}${A8S_PATHS.agents}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(createAgentRequestSchema.parse({
        spec: {
          agentId: 'a-sse',
          workspace: agentWorkspace,
          model: 'tier:strong',
          ensureDefaultMcpConfig: false,
        },
        entry: { tag: 'sse' },
      })),
    });
    expect(createResp.status).toBe(200);

    const mount = worker.get('a-sse');
    if (!mount) throw new Error('agent not mounted');
    const session = await mount.runtime.createSession();
    // Seed 3 historical events before opening the stream.
    for (let i = 0; i < 3; i++) {
      await mount.runtime.appendSessionEvent(session.id, {
        type: 'metadata', key: 'pre', value: i,
      });
    }

    // Open the stream against a8s (proxied to the worker).
    const ctrl = new AbortController();
    const streamResp = await fetch(
      `${a8sInfo.url}${A8S_PATHS.agentEventsStream('a-sse')}?session=${encodeURIComponent(session.id)}`,
      { headers: { accept: 'text/event-stream' }, signal: ctrl.signal },
    );
    expect(streamResp.status).toBe(200);
    expect(streamResp.headers.get('content-type')).toMatch(/text\/event-stream/);
    if (!streamResp.body) throw new Error('no body');

    const reader = streamResp.body.getReader();
    const decoder = new TextDecoder();
    const received: Array<{ id: string; type: string; data: Record<string, unknown> }> = [];
    let buffer = '';

    const readUntil = async (predicate: () => boolean, timeoutMs: number): Promise<void> => {
      const deadline = Date.now() + timeoutMs;
      while (!predicate() && Date.now() < deadline) {
        const race = await Promise.race([
          reader.read(),
          new Promise<{ value: undefined; done: true }>((resolve) =>
            setTimeout(() => resolve({ value: undefined, done: true }), Math.max(50, deadline - Date.now())),
          ),
        ]);
        if (race.done) break;
        buffer += decoder.decode(race.value, { stream: true });
        // Parse complete SSE messages (separated by blank line).
        let sep: number;
        while ((sep = buffer.indexOf('\n\n')) !== -1) {
          const block = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          const lines = block.split('\n').filter((l) => !l.startsWith(':'));
          const id = lines.find((l) => l.startsWith('id:'))?.slice(3).trim() ?? '';
          const type = lines.find((l) => l.startsWith('event:'))?.slice(6).trim() ?? '';
          const dataLine = lines.find((l) => l.startsWith('data:'))?.slice(5).trim() ?? '';
          if (!id) continue;
          received.push({ id, type, data: JSON.parse(dataLine) as Record<string, unknown> });
        }
      }
    };

    // Wait for the historical replay (session_start + 3 metadata).
    await readUntil(() => received.length >= 4, 3_000);
    expect(received.length).toBeGreaterThanOrEqual(4);
    const seenTypes = received.map((r) => r.type);
    expect(seenTypes[0]).toBe('session_start');
    expect(seenTypes.filter((t) => t === 'metadata').length).toBeGreaterThanOrEqual(3);

    // Append two more events and ensure they arrive live.
    const liveBaseline = received.length;
    await mount.runtime.appendSessionEvent(session.id, { type: 'metadata', key: 'live', value: 100 });
    await mount.runtime.appendSessionEvent(session.id, { type: 'metadata', key: 'live', value: 101 });
    await readUntil(() => received.length >= liveBaseline + 2, 3_000);
    const liveSlice = received.slice(liveBaseline);
    expect(liveSlice).toHaveLength(2);
    expect(liveSlice.map((r) => (r.data as { value: number }).value)).toEqual([100, 101]);

    // ---- Cancel + reconnect with Last-Event-ID; expect to *not* see the
    // already-delivered events, but to receive any subsequent ones. ----
    ctrl.abort();
    try { await reader.cancel(); } catch { /* aborted */ }
    const lastSeenId = received[received.length - 1].id;

    // Append a post-disconnect event before reconnecting so the resume
    // stream has something to deliver.
    await mount.runtime.appendSessionEvent(session.id, { type: 'metadata', key: 'resume', value: 200 });

    const ctrl2 = new AbortController();
    const resumeResp = await fetch(
      `${a8sInfo.url}${A8S_PATHS.agentEventsStream('a-sse')}?session=${encodeURIComponent(session.id)}`,
      {
        headers: {
          accept: 'text/event-stream',
          [SSE_LAST_EVENT_ID_HEADER]: lastSeenId,
        },
        signal: ctrl2.signal,
      },
    );
    expect(resumeResp.status).toBe(200);
    if (!resumeResp.body) throw new Error('no body');
    const reader2 = resumeResp.body.getReader();
    const resumeReceived: Array<{ id: string; data: Record<string, unknown> }> = [];
    let buf2 = '';
    const dec2 = new TextDecoder();
    const readUntil2 = async (predicate: () => boolean, timeoutMs: number): Promise<void> => {
      const deadline = Date.now() + timeoutMs;
      while (!predicate() && Date.now() < deadline) {
        const race = await Promise.race([
          reader2.read(),
          new Promise<{ value: undefined; done: true }>((resolve) =>
            setTimeout(() => resolve({ value: undefined, done: true }), Math.max(50, deadline - Date.now())),
          ),
        ]);
        if (race.done) break;
        buf2 += dec2.decode(race.value, { stream: true });
        let sep: number;
        while ((sep = buf2.indexOf('\n\n')) !== -1) {
          const block = buf2.slice(0, sep);
          buf2 = buf2.slice(sep + 2);
          const lines = block.split('\n').filter((l) => !l.startsWith(':'));
          const id = lines.find((l) => l.startsWith('id:'))?.slice(3).trim() ?? '';
          const dataLine = lines.find((l) => l.startsWith('data:'))?.slice(5).trim() ?? '';
          if (!id) continue;
          resumeReceived.push({ id, data: JSON.parse(dataLine) as Record<string, unknown> });
        }
      }
    };
    await readUntil2(() => resumeReceived.length >= 1, 3_000);
    // First event after resume must be the post-disconnect one.
    expect(resumeReceived.length).toBeGreaterThanOrEqual(1);
    expect((resumeReceived[0].data as { value: number }).value).toBe(200);
    // And we must not have re-delivered any id from before the cursor.
    const beforeCursorIds = new Set(received.map((r) => r.id));
    for (const r of resumeReceived) {
      expect(beforeCursorIds.has(r.id)).toBe(false);
    }

    ctrl2.abort();
    try { await reader2.cancel(); } catch { /* aborted */ }
    await reg.withdraw(true);
    await daemon.stop();
    await worker.dispose();
    await a8s.stop();
  });

  it('operator API: list workers/leases, cluster report, drain + evict', async () => {
    const orchestrator = new RuntimeOrchestrator({
      store: new MemoryRuntimeOrchestrationStore(),
    });
    const a8sPort = await pickPort();
    const a8s = new A8sServer<TestEntry>({
      port: a8sPort,
      controlPlane: { orchestrator },
      adminToken: 'op-secret',
    });
    const a8sInfo = await a8s.start();
    const adminHeaders = { authorization: 'Bearer op-secret' };

    // Two workers join.
    const setupWorker = async (id: string) => {
      const root = mkdtempSync(join(tmpdir(), `wd-op-${id}-`));
      const port = await pickPort();
      const env = makeTestWorkerEnv(root);
      const worker = new Worker<TestEntry>({ env });
      const daemon = new WorkerDaemon<TestEntry>({
        worker, workerId: id, port, bindHost: '127.0.0.1',
        resolveSpec: (wire) => ({
          agentId: wire.agentId, workspace: wire.workspace,
          home: new AgentHome(wire.workspace), projectRoot: wire.projectRoot,
          model: wire.model, ensureDefaultMcpConfig: false,
        }),
      });
      const info = await daemon.start();
      const reg = new WorkerRegistrationClient({
        a8sUrl: a8sInfo.url, workerId: id, callbackUrl: info.callbackUrl,
        capacity: 4, heartbeatTtlMs: 30_000, adminToken: 'op-secret',
      });
      const result = await reg.register();
      daemon.setAuthToken(result.workerToken);
      return { id, worker, daemon, reg };
    };
    const w1 = await setupWorker('op-1');
    const w2 = await setupWorker('op-2');

    // Spawn an agent so we have a lease + non-zero `used`.
    const agentWs = mkdtempSync(join(tmpdir(), 'op-agent-'));
    const createResp = await fetch(`${a8sInfo.url}${A8S_PATHS.agents}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...adminHeaders },
      body: JSON.stringify(createAgentRequestSchema.parse({
        spec: { agentId: 'op-a', workspace: agentWs, model: 'tier:strong', ensureDefaultMcpConfig: false },
        entry: { tag: 'op' },
      })),
    });
    expect(createResp.status).toBe(200);

    // ---- list workers ----
    const wlResp = await fetch(`${a8sInfo.url}${A8S_PATHS.operatorWorkers}`, { headers: adminHeaders });
    expect(wlResp.status).toBe(200);
    const wl = operatorWorkerListResponseSchema.parse(await wlResp.json());
    expect(wl.workers).toHaveLength(2);
    const w1Entry = wl.workers.find((w) => w.workerId === 'op-1')!;
    expect(w1Entry.state).toBe('active');
    expect(w1Entry.capacity).toBe(4);
    const totalUsed = wl.workers.reduce((sum, w) => sum + w.used, 0);
    expect(totalUsed).toBe(1);

    // ---- list leases ----
    const llResp = await fetch(`${a8sInfo.url}${A8S_PATHS.operatorLeases}`, { headers: adminHeaders });
    expect(llResp.status).toBe(200);
    const ll = operatorLeaseListResponseSchema.parse(await llResp.json());
    expect(ll.leases).toHaveLength(1);
    expect(ll.leases[0].agentId).toBe('op-a');
    expect(ll.leases[0].state).toBe('active');

    // ---- cluster report ----
    const crResp = await fetch(`${a8sInfo.url}${A8S_PATHS.operatorCluster}`, { headers: adminHeaders });
    expect(crResp.status).toBe(200);
    const cr = operatorClusterReportSchema.parse(await crResp.json());
    expect(cr.workerCount.total).toBe(2);
    expect(cr.workerCount.active).toBe(2);
    expect(cr.capacity.total).toBe(8);
    expect(cr.capacity.used).toBe(1);
    expect(cr.agentCount).toBe(1);

    // ---- drain ----
    const drainResp = await fetch(`${a8sInfo.url}${A8S_PATHS.operatorWorkerDrain('op-1')}`, {
      method: 'POST', headers: adminHeaders,
    });
    expect(drainResp.status).toBe(200);
    const wl2 = operatorWorkerListResponseSchema.parse(
      await (await fetch(`${a8sInfo.url}${A8S_PATHS.operatorWorkers}`, { headers: adminHeaders })).json(),
    );
    expect(wl2.workers.find((w) => w.workerId === 'op-1')!.state).toBe('draining');

    // ---- undrain ----
    const undrainResp = await fetch(`${a8sInfo.url}${A8S_PATHS.operatorWorkerUndrain('op-1')}`, {
      method: 'POST', headers: adminHeaders,
    });
    expect(undrainResp.status).toBe(200);
    const wl3 = operatorWorkerListResponseSchema.parse(
      await (await fetch(`${a8sInfo.url}${A8S_PATHS.operatorWorkers}`, { headers: adminHeaders })).json(),
    );
    expect(wl3.workers.find((w) => w.workerId === 'op-1')!.state).toBe('active');

    // ---- evict op-2 ----
    const evictResp = await fetch(`${a8sInfo.url}${A8S_PATHS.operatorWorkerEvict('op-2')}`, {
      method: 'POST', headers: adminHeaders,
    });
    expect(evictResp.status).toBe(200);
    const wl4 = operatorWorkerListResponseSchema.parse(
      await (await fetch(`${a8sInfo.url}${A8S_PATHS.operatorWorkers}`, { headers: adminHeaders })).json(),
    );
    const w2After = wl4.workers.find((w) => w.workerId === 'op-2');
    // withdrawWorker keeps the row but marks it withdrawn (state machine).
    expect(['evicted', 'withdrawn']).toContain(w2After?.state);

    // ---- 404 on unknown worker ----
    const ghostDrain = await fetch(`${a8sInfo.url}${A8S_PATHS.operatorWorkerDrain('ghost')}`, {
      method: 'POST', headers: adminHeaders,
    });
    expect(ghostDrain.status).toBe(404);

    // ---- 401 without admin token ----
    const noAuth = await fetch(`${a8sInfo.url}${A8S_PATHS.operatorWorkers}`);
    expect(noAuth.status).toBe(401);

    await w1.reg.withdraw(true);
    await w1.daemon.stop();
    await w1.worker.dispose();
    await w2.daemon.stop();
    await w2.worker.dispose();
    await a8s.stop();
  });

  it('bootstrap: local worker + admin agent appear in operator view', async () => {
    const orchestrator = new RuntimeOrchestrator({
      store: new MemoryRuntimeOrchestrationStore(),
    });
    const a8sPort = await pickPort();
    const a8s = new A8sServer<TestEntry>({
      port: a8sPort,
      controlPlane: { orchestrator },
      adminToken: 'boot-secret',
    });
    const a8sInfo = await a8s.start();
    const adminHeaders = { authorization: 'Bearer boot-secret' };

    const root = mkdtempSync(join(tmpdir(), 'a8s-boot-'));
    const agentsRoot = join(root, 'agents');
    const env = makeTestWorkerEnv(root);
    const worker = await ensureLocalWorker(a8s, {
      env,
      dataRoot: root,
      agentsRoot,
      capacity: 4,
      workerId: 'a8s-local',
    });
    const agentId = await ensureAdminAgent(a8s, worker, agentsRoot, 'boot-secret', {
      a8sPort,
    });
    expect(agentId).toBe('berry-admin');

    // ---- Local worker appears in operator list ----
    const wlResp = await fetch(`${a8sInfo.url}${A8S_PATHS.operatorWorkers}`, { headers: adminHeaders });
    const wl = operatorWorkerListResponseSchema.parse(await wlResp.json());
    const localEntry = wl.workers.find((w) => w.workerId === 'a8s-local');
    expect(localEntry).toBeDefined();
    // machine label is always stamped, default = os.hostname()
    expect(localEntry!.labels?.machine).toBeTypeOf('string');
    expect(localEntry!.labels?.machine?.length).toBeGreaterThan(0);

    // ---- Admin agent shows up as an active assignment ----
    const agentsResp = await fetch(`${a8sInfo.url}${A8S_PATHS.agents}`, { headers: adminHeaders });
    const agents = listAgentsResponseSchema.parse(await agentsResp.json());
    const admin = agents.agents.find((a) => a.agentId === 'berry-admin');
    expect(admin).toBeDefined();
    expect(admin!.workerId).toBe('a8s-local');

    // ---- Admin agent has the cluster-admin hand mounted ----
    const mount = worker.get('berry-admin');
    expect(mount).toBeDefined();
    expect(mount!.runtime.hasHand?.('cluster-admin')).toBe(true);

    // ---- Idempotent: calling ensureAdminAgent again is a no-op ----
    await ensureAdminAgent(a8s, worker, agentsRoot, 'boot-secret', { a8sPort });
    const agentsResp2 = await fetch(`${a8sInfo.url}${A8S_PATHS.agents}`, { headers: adminHeaders });
    const agents2 = listAgentsResponseSchema.parse(await agentsResp2.json());
    expect(agents2.agents.filter((a) => a.agentId === 'berry-admin')).toHaveLength(1);

    await worker.dispose();
    await a8s.stop();
  });

  it('operator join-script generator: refuses in dev mode, otherwise embeds admin token', async () => {
    // ---- Dev mode: refuse ----
    const orchA = new RuntimeOrchestrator({ store: new MemoryRuntimeOrchestrationStore() });
    const portA = await pickPort();
    const a8sA = new A8sServer<TestEntry>({ port: portA, controlPlane: { orchestrator: orchA } });
    const infoA = await a8sA.start();
    const devResp = await fetch(`${infoA.url}${A8S_PATHS.operatorWorkerJoinScript}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(devResp.status).toBe(409);
    await a8sA.stop();

    // ---- With admin token: returns a snippet that embeds it + advertiseUrl ----
    const orchB = new RuntimeOrchestrator({ store: new MemoryRuntimeOrchestrationStore() });
    const portB = await pickPort();
    const a8sB = new A8sServer<TestEntry>({
      port: portB,
      controlPlane: { orchestrator: orchB },
      adminToken: 'join-secret',
      advertiseUrl: 'https://a8s.example.com',
    });
    const infoB = await a8sB.start();
    const respB = await fetch(`${infoB.url}${A8S_PATHS.operatorWorkerJoinScript}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer join-secret',
      },
      body: JSON.stringify({ capacity: 8, port: 7101, labels: { region: 'us-west' } }),
    });
    expect(respB.status).toBe(200);
    const parsed = await respB.json() as { script: string; resolved: Record<string, unknown> };
    expect(parsed.script).toContain('https://a8s.example.com');
    expect(parsed.script).toContain('join-secret');
    // JSON.stringify with no indent — compact form
    expect(parsed.script).toContain('{"region":"us-west"}');
    expect(parsed.script).toMatch(/CAPACITY="?8/);
    expect(parsed.resolved.port).toBe(7101);
    expect(parsed.resolved.a8sUrl).toBe('https://a8s.example.com');

    // ---- Without admin token: 401 ----
    const noAuth = await fetch(`${infoB.url}${A8S_PATHS.operatorWorkerJoinScript}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(noAuth.status).toBe(401);

    await a8sB.stop();
  });

  it('wake scheduler fires due wakes and marks unrecoverable ones as failed', async () => {
    const orchestrator = new RuntimeOrchestrator({
      store: new MemoryRuntimeOrchestrationStore(),
    });
    const a8sPort = await pickPort();
    const a8s = new A8sServer<TestEntry>({
      port: a8sPort,
      controlPlane: { orchestrator },
      adminToken: 'wake-secret',
      // Tight tick so the test doesn't sit idle. Min sane interval.
      wakeTickMs: 50,
    });
    const a8sInfo = await a8s.start();

    // Schedule a wake for an agent that doesn't exist — deliverWake will
    // throw 'no assigned worker' and the scheduler should mark the wake
    // as failed (not pending forever).
    const dueAt = Date.now() + 10;
    const schedResp = await fetch(`${a8sInfo.url}${A8S_PATHS.wakesSchedule}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer wake-secret' },
      body: JSON.stringify({
        agentId: 'ghost',
        dueAt,
        reason: 'test-tick',
        payload: { hello: 'world' },
      }),
    });
    expect(schedResp.status).toBe(200);
    const { wakeId } = await schedResp.json() as { wakeId: string };

    // Poll the orchestrator until the wake leaves the pending state.
    const deadline = Date.now() + 2_000;
    let finalState: string | undefined;
    while (Date.now() < deadline) {
      const all = await orchestrator.listPendingWakes(Date.now() + 1_000_000);
      const stillPending = all.find((w) => w.wakeId === wakeId);
      if (!stillPending) {
        // Fell out of pending — fetch via a fresh scheduleWake reuse is
        // overkill; the snapshot tells us via state from a different path.
        // Re-query through the store directly by listing all wakes via
        // a tiny helper: claimDueWakes won't show non-pending either.
        // Easiest: peek snapshot through the store transact.
        finalState = await orchestrator['options'].store.transact((snap) => ({
          snapshot: snap,
          result: snap.wakes.find((w) => w.wakeId === wakeId)?.state,
        }));
        break;
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(finalState).toBe('failed');

    await a8s.stop();
  });

  it('serves the built-in operator UI on / and /ui without admin token', async () => {
    const orchestrator = new RuntimeOrchestrator({
      store: new MemoryRuntimeOrchestrationStore(),
    });
    const a8sPort = await pickPort();
    const a8s = new A8sServer<TestEntry>({
      port: a8sPort,
      controlPlane: { orchestrator },
      adminToken: 'ui-secret',
    });
    const a8sInfo = await a8s.start();

    for (const path of ['/', '/ui', '/ui/']) {
      const resp = await fetch(`${a8sInfo.url}${path}`);
      expect(resp.status).toBe(200);
      expect(resp.headers.get('content-type')).toMatch(/text\/html/);
      const html = await resp.text();
      expect(html).toContain('berry-a8s');
      expect(html).toContain('/v1/operator/cluster');
      // The HTML must NOT contain the admin token — only the browser
      // collects it via the modal.
      expect(html).not.toContain('ui-secret');
    }
    await a8s.stop();
  });

  it('worker restart: re-mounts owned agents from disk via register response', async () => {
    // Persistence is the whole point: use an actual durable store (memory
    // is fine in-process since both worker instances share one JS heap;
    // the real failure mode we care about is the worker DAEMON dying and
    // a fresh one taking over, not the store dying).
    const orchestrator = new RuntimeOrchestrator({
      store: new MemoryRuntimeOrchestrationStore(),
    });
    const a8sPort = await pickPort();
    const a8s = new A8sServer<TestEntry>({
      port: a8sPort,
      controlPlane: { orchestrator },
      adminToken: 'rh-secret',
    });
    const a8sInfo = await a8s.start();
    const adminHeaders = { authorization: 'Bearer rh-secret' };

    // Shared, machine-scoped agents dir. This is the "data follows the
    // machine, not the worker process" contract we're testing.
    const agentsRoot = mkdtempSync(join(tmpdir(), 'rh-agents-'));

    // First worker daemon instance ----
    const dataRoot1 = mkdtempSync(join(tmpdir(), 'rh-w1-'));
    const port1 = await pickPort();
    const env1 = makeTestWorkerEnv(dataRoot1);
    const worker1 = new Worker<TestEntry>({ env: env1 });
    const daemon1 = new WorkerDaemon<TestEntry>({
      worker: worker1, workerId: 'rh-w', port: port1, bindHost: '127.0.0.1',
      resolveSpec: (wire) => ({
        agentId: wire.agentId,
        workspace: wire.workspace.includes('/') ? wire.workspace : join(agentsRoot, wire.workspace),
        home: new AgentHome(wire.workspace.includes('/') ? wire.workspace : join(agentsRoot, wire.workspace)),
        projectRoot: wire.projectRoot,
        model: wire.model,
        ensureDefaultMcpConfig: false,
      }),
    });
    const d1Info = await daemon1.start();
    const reg1 = new WorkerRegistrationClient({
      a8sUrl: a8sInfo.url, workerId: 'rh-w', callbackUrl: d1Info.callbackUrl,
      capacity: 4, heartbeatTtlMs: 30_000, adminToken: 'rh-secret',
      labels: { machine: 'machine-A' },
    });
    const reg1Result = await reg1.register();
    daemon1.setAuthToken(reg1Result.workerToken);
    // First registration: no prior leases.
    expect(reg1Result.ownedAgents).toHaveLength(0);

    // Spawn an agent through a8s ----
    const createResp = await fetch(`${a8sInfo.url}${A8S_PATHS.agents}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...adminHeaders },
      body: JSON.stringify(createAgentRequestSchema.parse({
        spec: {
          agentId: 'rh-a',
          workspace: 'rh-a',  // bare id -> resolveSpec puts it under agentsRoot
          model: 'tier:strong',
          ensureDefaultMcpConfig: false,
        },
        entry: { tag: 'rh' },
      })),
    });
    expect(createResp.status).toBe(200);
    expect(worker1.has('rh-a')).toBe(true);
    // agent.json must exist on disk for rehydrate to find a model.
    const { writeFileSync, existsSync } = await import('node:fs');
    const metaPath = join(agentsRoot, 'rh-a', 'agent.json');
    // The runtime writes agent.json on first init, but in tests we may
    // race the assertion. Make sure it exists by seeding if missing.
    if (!existsSync(metaPath)) {
      writeFileSync(
        metaPath,
        JSON.stringify({ id: 'rh-a', name: 'rh-a', createdAt: new Date().toISOString(), model: 'tier:strong' }),
        'utf-8',
      );
    }

    // ---- Simulate worker crash: stop daemon + dispose, leave the
    //      agent home + leases intact. We do NOT call reg.withdraw() —
    //      that's the graceful exit, which deliberately releases leases.
    //      A crash leaves the lease in place until TTL expiry.
    await daemon1.stop();
    await worker1.dispose();

    // Second worker daemon instance — same workerId, same agentsRoot,
    // different process state (fresh Worker, fresh env). This is what
    // systemd Restart=always would give us.
    const dataRoot2 = mkdtempSync(join(tmpdir(), 'rh-w2-'));
    const port2 = await pickPort();
    const env2 = makeTestWorkerEnv(dataRoot2);
    const worker2 = new Worker<TestEntry>({ env: env2 });
    const daemon2 = new WorkerDaemon<TestEntry>({
      worker: worker2, workerId: 'rh-w', port: port2, bindHost: '127.0.0.1',
      resolveSpec: (wire) => ({
        agentId: wire.agentId,
        workspace: wire.workspace.includes('/') ? wire.workspace : join(agentsRoot, wire.workspace),
        home: new AgentHome(wire.workspace.includes('/') ? wire.workspace : join(agentsRoot, wire.workspace)),
        projectRoot: wire.projectRoot,
        model: wire.model,
        ensureDefaultMcpConfig: false,
      }),
    });
    const d2Info = await daemon2.start();
    const reg2 = new WorkerRegistrationClient({
      a8sUrl: a8sInfo.url, workerId: 'rh-w', callbackUrl: d2Info.callbackUrl,
      capacity: 4, heartbeatTtlMs: 30_000, adminToken: 'rh-secret',
      labels: { machine: 'machine-A' },
    });
    const reg2Result = await reg2.register();
    daemon2.setAuthToken(reg2Result.workerToken);

    // Core claim: a8s knew this worker should own rh-a, so the response
    // tells the daemon to rehydrate it.
    expect(reg2Result.ownedAgents).toContain('rh-a');

    // Simulate the rehydrate loop the CLI runs (we don't drive the CLI
    // process directly in this test — just exercise the same code path).
    for (const agentId of reg2Result.ownedAgents) {
      const workspace = join(agentsRoot, agentId);
      const home = new AgentHome(workspace);
      const raw = await import('node:fs/promises').then((m) => m.readFile(home.metadataPath, 'utf-8'));
      const meta = JSON.parse(raw) as { model: string };
      worker2.runAgentSync(agentId, {}, {
        agentId, workspace, home,
        model: meta.model, ensureDefaultMcpConfig: false,
      });
    }
    expect(worker2.has('rh-a')).toBe(true);

    // a8s now routes the agent to the new daemon. listAgents reports it.
    const listResp = await fetch(`${a8sInfo.url}${A8S_PATHS.agents}`, { headers: adminHeaders });
    const list = listAgentsResponseSchema.parse(await listResp.json());
    expect(list.agents.find((a) => a.agentId === 'rh-a')?.workerId).toBe('rh-w');

    await reg2.withdraw(true);
    await daemon2.stop();
    await worker2.dispose();
    await a8s.stop();
  });
});
