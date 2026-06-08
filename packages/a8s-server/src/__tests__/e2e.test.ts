// ============================================================
// E2E: a8s-server + worker-daemon over real HTTP
// ============================================================
// Spins up a real a8s-server + 2 worker daemons on random ports, has
// each daemon register over HTTP, then creates an agent and asserts that
// it was actually mounted on one of the workers. No mocks for the
// HTTP layer — verifies the wire protocol round-trips correctly.

import { describe, expect, it } from 'vitest';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  A8S_PATHS,
  adminAgentStatusResponseSchema,
  createAgentRequestSchema,
  createAgentResponseSchema,
  listAgentsResponseSchema,
  agentSnapshotResponseSchema,
  skillListResponseSchema,
  skillRemoveResponseSchema,
  operatorClusterReportSchema,
  operatorLeaseListResponseSchema,
  operatorWorkerListResponseSchema,
  sessionEventsResponseSchema,
  sessionListResponseSchema,
  sessionCreateResponseSchema,
  sessionViewResponseSchema,
  sessionDeleteResponseSchema,
  sessionClearResponseSchema,
  sessionTodosResponseSchema,
  sessionAppendEventResponseSchema,
  SSE_LAST_EVENT_ID_HEADER,
  agentUsageResponseSchema,
  operatorUsageResponseSchema,
  usageSessionListResponseSchema,
  usageTurnListResponseSchema,
  usageInferenceListResponseSchema,
  usageInferenceDetailResponseSchema,
} from '@berry-agent/cluster-protocol';
import { AgentHome } from '@berry-agent/core';
import {
  MemoryRuntimeOrchestrationStore,
  RuntimeOrchestrator,
} from '@berry-agent/runtime';
import { Worker } from '@berry-agent/worker';
import { makeTestWorkerEnv } from '@berry-agent/worker/test-utils';
import { MetricsCalculator } from '@berry-agent/observe';
import {
  WorkerDaemon,
  WorkerRegistrationClient,
  withAdminOpsEnv,
  withMachineHostTools,
} from '@berry-agent/worker-daemon';
import {
  MachineConnectorDaemon,
  MachineRegistrationClient,
} from '@berry-agent/machine-connector';
import { A8sServer } from '../server.js';
import { ensureAdminAgent } from '../bootstrap.js';

interface TestEntry { tag: string }

async function pickPort(): Promise<number> {
  // Probe a free port by binding to 0 and reading the assignment. A few tests
  // deliberately restart a server on the SAME port (catastrophic-restart
  // simulation), so callers need a concrete, reusable port — not 0. Servers
  // also read their actually-bound port back from .start(), so a port that
  // gets stolen between probe and bind still yields a working url; the rare
  // residual EADDRINUSE only hits same-port-rebind tests.
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

/**
 * Spin up a real in-test worker daemon and register it with a8s, with the
 * SAME label-driven tool injection the production berry-worker CLI applies
 * (cluster-admin + machine + base resolveSpec). This replaces the removed
 * a8s-server `ensureLocalWorker` shortcut — a8s no longer runs a worker
 * itself, so even tests go through a genuine worker over HTTP. The daemon
 * shares the test process, so `result.worker.get(agentId)` still lets a
 * test introspect a mounted runtime.
 */
async function startTestWorker(opts: {
  a8sUrl: string;
  adminToken: string;
  workerId?: string;
  root: string;
  capacity?: number;
}): Promise<{ worker: Worker<TestEntry>; stop: () => Promise<void> }> {
  const workerId = opts.workerId ?? 'test-worker';
  const agentsRoot = join(opts.root, 'agents');
  const env = makeTestWorkerEnv(opts.root);
  const worker = new Worker<TestEntry>({ env });
  // Consumption read path: serve the agent rollup from this worker's observe
  // store, exactly like the CLI wires it.
  const metrics = new MetricsCalculator(env.observer.analyzer, env.observer.db);
  const base = (wire: import('@berry-agent/worker-daemon').WireResolveInput) => {
    const workspace = wire.workspace.includes('/') ? wire.workspace : join(agentsRoot, wire.workspace);
    return {
      agentId: wire.agentId,
      workspace,
      home: new AgentHome(workspace),
      projectRoot: wire.projectRoot,
      model: wire.model,
      ensureDefaultMcpConfig: false,
    };
  };
  // Layer the production resolveSpec wrappers, exactly like the CLI.
  let resolveSpec = base;
  resolveSpec = withAdminOpsEnv(resolveSpec, { a8sUrl: opts.a8sUrl, adminToken: opts.adminToken });
  resolveSpec = withMachineHostTools(resolveSpec, { a8sUrl: opts.a8sUrl, adminToken: opts.adminToken });

  const wPort = await pickPort();
  const daemon = new WorkerDaemon<TestEntry>({
    worker, workerId, port: wPort, bindHost: '127.0.0.1', resolveSpec,
    usage: (agentId) => metrics.agentMetrics(agentId),
    usageSessions: (agentId) => env.observer.analyzer.recentSessions(100, agentId),
    usageTurns: (sessionId) => env.observer.analyzer.turnList({ sessionId, limit: 200 }),
    usageInferences: (turnId) => env.observer.analyzer.inferenceList({ turnId, limit: 200 }),
    usageInferenceDetail: (inferenceId) => env.observer.analyzer.inferenceDetail(inferenceId),
  });
  const dInfo = await daemon.start();
  const reg = new WorkerRegistrationClient({
    a8sUrl: opts.a8sUrl,
    workerId,
    callbackUrl: dInfo.callbackUrl,
    capacity: opts.capacity ?? 4,
    heartbeatTtlMs: 30_000,
    adminToken: opts.adminToken,
  });
  daemon.setAuthToken((await reg.register()).workerToken);
  return {
    worker,
    stop: async () => {
      await reg.withdraw(true).catch(() => {});
      await daemon.stop();
      await worker.dispose();
    },
  };
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

  it('session write ops (create/get/clear/delete/todos) round-trip through a8s → worker', async () => {
    const orchestrator = new RuntimeOrchestrator({ store: new MemoryRuntimeOrchestrationStore() });
    const a8sPort = await pickPort();
    const a8s = new A8sServer<TestEntry>({ port: a8sPort, controlPlane: { orchestrator } });
    const a8sInfo = await a8s.start();

    const root = mkdtempSync(join(tmpdir(), 'wd-sesswrite-'));
    const wPort = await pickPort();
    const env = makeTestWorkerEnv(root);
    const worker = new Worker<TestEntry>({ env });
    const daemon = new WorkerDaemon<TestEntry>({
      worker,
      workerId: 'wd-sesswrite',
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
      workerId: 'wd-sesswrite',
      callbackUrl: dInfo.callbackUrl,
      capacity: 4,
      heartbeatTtlMs: 30_000,
    });
    const regResult = await reg.register();
    daemon.setAuthToken(regResult.workerToken);

    const agentWorkspace = mkdtempSync(join(tmpdir(), 'wd-sesswrite-agent-'));
    await fetch(`${a8sInfo.url}${A8S_PATHS.agents}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(createAgentRequestSchema.parse({
        spec: { agentId: 'a-sw', workspace: agentWorkspace, model: 'tier:strong', ensureDefaultMcpConfig: false },
        entry: { tag: 'sw' },
      })),
    });

    // ---- Create a session via a8s ----
    const createResp = await fetch(`${a8sInfo.url}${A8S_PATHS.agentSessions('a-sw')}`, { method: 'POST' });
    expect(createResp.status).toBe(200);
    const created = sessionCreateResponseSchema.parse(await createResp.json());
    const sid = created.session.id;
    expect(sid).toBeTruthy();

    // ---- Get that one full view ----
    const getResp = await fetch(`${a8sInfo.url}${A8S_PATHS.agentSession('a-sw', sid)}`);
    expect(getResp.status).toBe(200);
    const got = sessionViewResponseSchema.parse(await getResp.json());
    expect(got.session?.id).toBe(sid);

    // ---- Append an event to the durable log (e.g. an approval record) ----
    const appendResp = await fetch(`${a8sInfo.url}${A8S_PATHS.agentSessionEvents('a-sw', sid)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ event: { type: 'metadata', key: 'probe', value: 1 } }),
    });
    expect(appendResp.status).toBe(200);
    const appended = sessionAppendEventResponseSchema.parse(await appendResp.json());
    expect(appended.event).not.toBeNull();

    // ---- Todos (empty for a fresh session) ----
    const todosResp = await fetch(`${a8sInfo.url}${A8S_PATHS.agentSessionTodos('a-sw', sid)}`);
    expect(todosResp.status).toBe(200);
    const todos = sessionTodosResponseSchema.parse(await todosResp.json());
    expect(Array.isArray(todos.todos)).toBe(true);

    // ---- Clear: returns the (possibly fresh) view ----
    const clearResp = await fetch(`${a8sInfo.url}${A8S_PATHS.agentSessionClear('a-sw', sid)}`, { method: 'POST' });
    expect(clearResp.status).toBe(200);
    const cleared = sessionClearResponseSchema.parse(await clearResp.json());
    expect(cleared.sessionId).toBeTruthy();

    // ---- Delete ----
    const delTarget = cleared.sessionId;
    const delResp = await fetch(`${a8sInfo.url}${A8S_PATHS.agentSession('a-sw', delTarget)}`, { method: 'DELETE' });
    expect(delResp.status).toBe(200);
    const deleted = sessionDeleteResponseSchema.parse(await delResp.json());
    expect(deleted.sessionId).toBe(delTarget);

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

  it('admin agent: scheduled onto a real worker, gets ops skills + a8s creds by label (no hardcoded tools)', async () => {
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
    const w = await startTestWorker({ a8sUrl: a8sInfo.url, adminToken: 'boot-secret', workerId: 'w-admin', root });

    const agentId = await ensureAdminAgent(a8s.plane);
    expect(agentId).toBe('berry-admin');

    // ---- Admin agent shows up as an active assignment on the worker ----
    const agentsResp = await fetch(`${a8sInfo.url}${A8S_PATHS.agents}`, { headers: adminHeaders });
    const agents = listAgentsResponseSchema.parse(await agentsResp.json());
    const admin = agents.agents.find((a) => a.agentId === 'berry-admin');
    expect(admin).toBeDefined();
    expect(admin!.workerId).toBe('w-admin');

    // ---- The worker recognized the a8s-admin label (via withAdminOpsEnv,
    // the same path the CLI uses) and wired the agent for cluster ops the
    // 新-2 way: NO hardcoded cluster tools — ops are a CLI + skill now.
    // a8s-server itself never touches admin-ops code. ----
    const mount = w.worker.get('berry-admin');
    expect(mount).toBeDefined();
    const toolNames = new Set(mount!.runtime.getTools().map((t) => t.name));
    // The old hardcoded cluster tools are gone; the agent drives berry-a8s-ops.
    expect(toolNames.has('cluster_report')).toBe(false);
    expect(toolNames.has('drain_worker')).toBe(false);
    expect(toolNames.has('worker_join_script')).toBe(false);

    // ---- First-boot seeded both ops skills into the agent home ----
    expect(existsSync(join(agentsRoot, 'berry-admin', 'skills', 'a8s-ops', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(agentsRoot, 'berry-admin', 'skills', 'install-worker', 'SKILL.md'))).toBe(true);

    // ---- Snapshot endpoint reports the agent 4+1-natively (hands, not just
    // flat tools) — proxied a8s → worker. This is what a product BFF reads to
    // show "this agent has these Hands". ----
    const snapResp = await fetch(`${a8sInfo.url}${A8S_PATHS.agentSnapshot('berry-admin')}`, { headers: adminHeaders });
    expect(snapResp.status).toBe(200);
    const snap = agentSnapshotResponseSchema.parse(await snapResp.json());
    expect(Array.isArray(snap.hands)).toBe(true);
    // The admin agent has a workspace hand (file/shell/search) at minimum.
    expect(snap.hands.some((h) => h.capabilities.includes('shell'))).toBe(true);
    expect(typeof snap.model).toBe('string');

    // ---- Skill install/list/remove round-trip, proxied a8s → worker home ----
    const skillBody = JSON.stringify({ name: 'e2e-probe', content: '---\nname: e2e-probe\ndescription: probe\n---\nbody' });
    const instResp = await fetch(`${a8sInfo.url}${A8S_PATHS.agentSkills('berry-admin')}`, {
      method: 'POST', headers: { ...adminHeaders, 'content-type': 'application/json' }, body: skillBody,
    });
    expect(instResp.status).toBe(200);
    const listResp = await fetch(`${a8sInfo.url}${A8S_PATHS.agentSkills('berry-admin')}`, { headers: adminHeaders });
    const list = skillListResponseSchema.parse(await listResp.json());
    expect(list.names).toContain('e2e-probe');
    // Snapshot now reflects the newly installed skill in its index.
    const snap2 = agentSnapshotResponseSchema.parse(
      await fetch(`${a8sInfo.url}${A8S_PATHS.agentSnapshot('berry-admin')}`, { headers: adminHeaders }).then((r) => r.json()),
    );
    expect(snap2.skills.some((s) => s.name === 'e2e-probe')).toBe(true);
    const delResp = await fetch(`${a8sInfo.url}${A8S_PATHS.agentSkill('berry-admin', 'e2e-probe')}`, {
      method: 'DELETE', headers: adminHeaders,
    });
    expect(skillRemoveResponseSchema.parse(await delResp.json()).removed).toBe(true);

    // ---- Idempotent: calling ensureAdminAgent again is a no-op ----
    await ensureAdminAgent(a8s.plane);
    const agentsResp2 = await fetch(`${a8sInfo.url}${A8S_PATHS.agents}`, { headers: adminHeaders });
    const agents2 = listAgentsResponseSchema.parse(await agentsResp2.json());
    expect(agents2.agents.filter((a) => a.agentId === 'berry-admin')).toHaveLength(1);

    // ---- berry-admin's agent.json went through the normal config path:
    // it carries a `model` (the default tier:strong, persisted like any agent)
    // and the a8s-admin label wiring above still fired. No special shortcut. ----
    const adminMeta = JSON.parse(
      readFileSync(join(agentsRoot, 'berry-admin', 'agent.json'), 'utf-8'),
    ) as { model?: string };
    expect(adminMeta.model).toBe('tier:strong');

    await w.stop();
    await a8s.stop();
  });

  it('operator admin-agent endpoint: GET reports absent, POST schedules it, idempotent', async () => {
    const orchestrator = new RuntimeOrchestrator({ store: new MemoryRuntimeOrchestrationStore() });
    const a8sPort = await pickPort();
    const a8s = new A8sServer<TestEntry>({
      port: a8sPort,
      controlPlane: { orchestrator },
      adminToken: 'op-secret',
    });
    const a8sInfo = await a8s.start();
    const headers = { authorization: 'Bearer op-secret', 'content-type': 'application/json' };
    const adminUrl = `${a8sInfo.url}${A8S_PATHS.operatorAdminAgent}`;

    const root = mkdtempSync(join(tmpdir(), 'a8s-adminep-'));
    const w = await startTestWorker({ a8sUrl: a8sInfo.url, adminToken: 'op-secret', workerId: 'w-op', root });

    // ---- GET before bootstrap: absent ----
    const before = adminAgentStatusResponseSchema.parse(
      await fetch(adminUrl, { headers }).then((r) => r.json()),
    );
    expect(before.present).toBe(false);
    expect(before.workerId).toBeNull();

    // ---- POST: schedules berry-admin onto the worker ----
    const created = adminAgentStatusResponseSchema.parse(
      await fetch(adminUrl, { method: 'POST', headers, body: '{}' }).then((r) => r.json()),
    );
    expect(created.present).toBe(true);
    expect(created.workerId).toBe('w-op');

    // ---- POST again: idempotent, still one berry-admin ----
    await fetch(adminUrl, { method: 'POST', headers, body: '{}' });
    const agents = listAgentsResponseSchema.parse(
      await fetch(`${a8sInfo.url}${A8S_PATHS.agents}`, { headers }).then((r) => r.json()),
    );
    expect(agents.agents.filter((a) => a.agentId === 'berry-admin')).toHaveLength(1);

    // ---- Requires admin token ----
    const unauth = await fetch(adminUrl, { headers: { 'content-type': 'application/json' } });
    expect(unauth.status).toBe(401);

    await w.stop();
    await a8s.stop();
  });

  it('skill registry: operator lists the catalog and installs a built-in skill onto an agent (B6)', async () => {
    const orchestrator = new RuntimeOrchestrator({ store: new MemoryRuntimeOrchestrationStore() });
    const a8sPort = await pickPort();
    const root = mkdtempSync(join(tmpdir(), 'a8s-skillreg-'));
    const a8s = new A8sServer<TestEntry>({
      port: a8sPort,
      controlPlane: { orchestrator },
      adminToken: 'skill-secret',
      auditRoot: join(root, 'audit'),
    });
    const a8sInfo = await a8s.start();
    const headers = { authorization: 'Bearer skill-secret', 'content-type': 'application/json' };

    const w = await startTestWorker({ a8sUrl: a8sInfo.url, adminToken: 'skill-secret', workerId: 'w-skill', root });

    // ---- Catalog lists the built-ins ----
    const catResp = await fetch(`${a8sInfo.url}${A8S_PATHS.operatorSkills}`, { headers });
    expect(catResp.status).toBe(200);
    const cat = await catResp.json() as { skills: Array<{ name: string; builtin: boolean; description: string }> };
    const team = cat.skills.find((s) => s.name === 'team');
    expect(team).toBeDefined();
    expect(team!.builtin).toBe(true);
    expect(team!.description.length).toBeGreaterThan(0);

    // ---- Detail carries content verbatim ----
    const detailResp = await fetch(`${a8sInfo.url}${A8S_PATHS.operatorSkill('team')}`, { headers });
    expect(detailResp.status).toBe(200);
    const detail = await detailResp.json() as { content: string };
    expect(detail.content).toContain('berry-team');

    // ---- Create an agent, then install the 'team' skill onto it ----
    await fetch(`${a8sInfo.url}${A8S_PATHS.agents}`, {
      method: 'POST', headers,
      body: JSON.stringify({ spec: { agentId: 'skilled', workspace: 'skilled', model: 'tier:strong', ensureDefaultMcpConfig: false } }),
    }).then((r) => { expect(r.status).toBe(200); });

    const installResp = await fetch(
      `${a8sInfo.url}${A8S_PATHS.operatorAgentInstallSkill('skilled', 'team')}`,
      { method: 'POST', headers, body: '{}' },
    );
    expect(installResp.status, await installResp.clone().text()).toBe(200);
    const install = await installResp.json() as { ok: boolean; name: string };
    expect(install.ok).toBe(true);
    expect(install.name).toBe('team');

    // ---- The agent's own /skills now lists it ----
    const agentSkills = await fetch(`${a8sInfo.url}/v1/agents/skilled/skills`, { headers })
      .then((r) => r.json()) as { names: string[] };
    expect(agentSkills.names).toContain('team');

    // ---- Installing an unknown skill → 404 ----
    const unknown = await fetch(
      `${a8sInfo.url}${A8S_PATHS.operatorAgentInstallSkill('skilled', 'nope')}`,
      { method: 'POST', headers, body: '{}' },
    );
    expect(unknown.status).toBe(404);

    // ---- Operator can register + remove a custom skill ----
    const reg = await fetch(`${a8sInfo.url}${A8S_PATHS.operatorSkills}`, {
      method: 'POST', headers,
      body: JSON.stringify({
        name: 'house-style',
        description: 'Write in the house style.',
        content: '---\nname: house-style\ndescription: Write in the house style.\n---\n# House style',
      }),
    });
    expect(reg.status).toBe(200);
    const afterReg = await fetch(`${a8sInfo.url}${A8S_PATHS.operatorSkills}`, { headers })
      .then((r) => r.json()) as { skills: Array<{ name: string }> };
    expect(afterReg.skills.some((s) => s.name === 'house-style')).toBe(true);

    const del = await fetch(`${a8sInfo.url}${A8S_PATHS.operatorSkill('house-style')}`, { method: 'DELETE', headers });
    expect(del.status).toBe(200);

    // ---- Built-ins are protected from overwrite ----
    const clobber = await fetch(`${a8sInfo.url}${A8S_PATHS.operatorSkills}`, {
      method: 'POST', headers,
      body: JSON.stringify({ name: 'team', description: 'evil', content: 'x' }),
    });
    expect(clobber.status).toBe(409);

    await w.stop();
    await a8s.stop();
  });

  it('agent config plane: home read/write + spec patch + status proxy through a8s to the worker', async () => {
    const orchestrator = new RuntimeOrchestrator({ store: new MemoryRuntimeOrchestrationStore() });
    const a8sPort = await pickPort();
    const a8s = new A8sServer<TestEntry>({ port: a8sPort, controlPlane: { orchestrator }, adminToken: 'cfg-secret' });
    const a8sInfo = await a8s.start();
    const headers = { authorization: 'Bearer cfg-secret', 'content-type': 'application/json' };

    const root = mkdtempSync(join(tmpdir(), 'a8s-cfg-'));
    const w = await startTestWorker({ a8sUrl: a8sInfo.url, adminToken: 'cfg-secret', workerId: 'w-cfg', root });

    // Create an agent on the worker.
    await fetch(`${a8sInfo.url}${A8S_PATHS.agents}`, {
      method: 'POST', headers,
      body: JSON.stringify({ spec: { agentId: 'cfg-agent', workspace: 'cfg-agent', model: 'tier:strong', ensureDefaultMcpConfig: false } }),
    }).then((r) => { expect(r.status).toBe(200); });

    const base = `${a8sInfo.url}/v1/agents/cfg-agent`;

    // ---- write + read memory (a home doc) ----
    const wrote = await fetch(`${base}/home/memory`, {
      method: 'PUT', headers, body: JSON.stringify({ content: 'remember: berry' }),
    });
    expect(wrote.status).toBe(200);
    expect((await wrote.json()).bytes).toBeGreaterThan(0);

    const readBack = await fetch(`${base}/home/memory`, { headers }).then((r) => r.json());
    expect(readBack.doc).toBe('memory');
    expect(readBack.content).toContain('remember: berry');

    // ---- status proxies the live runtime ----
    const status = await fetch(`${base}/status`, { headers }).then((r) => r.json());
    expect(typeof status.status).toBe('string');

    // ---- spec patch (toolDenylist) returns ok ----
    const patched = await fetch(`${base}/spec`, {
      method: 'PATCH', headers, body: JSON.stringify({ toolDenylist: ['shell'] }),
    });
    expect(patched.status).toBe(200);
    expect((await patched.json()).ok).toBe(true);

    // ---- unknown home doc → 4xx (zod enum reject) ----
    const bad = await fetch(`${base}/home/bogus`, { headers });
    expect(bad.status).toBeGreaterThanOrEqual(400);

    await w.stop();
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
      // Page either has the React-app shell ("root") or the fallback
      // ("UI assets are missing"); both are valid depending on whether
      // the ui/ subpackage has been built.
      expect(html).toMatch(/(root|UI assets are missing|berry-a8s)/);
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

  it('a8s restart with wiped store: worker self-reports mounts, a8s reconciles', async () => {
    // Simulate the "a8s lost its memory store + worker still running" case.
    // Use two separate A8sServer instances backed by SEPARATE memory stores
    // (not one shared store) so the second instance starts truly blank.
    const a8sPort = await pickPort();
    const agentsRoot = mkdtempSync(join(tmpdir(), 'rc-agents-'));
    const adminHeaders = { authorization: 'Bearer rc-secret' };

    // ---- Round 1: a8s + worker + agent ----
    const orch1 = new RuntimeOrchestrator({ store: new MemoryRuntimeOrchestrationStore() });
    const a8s1 = new A8sServer<TestEntry>({
      port: a8sPort, controlPlane: { orchestrator: orch1 }, adminToken: 'rc-secret',
    });
    const a8s1Info = await a8s1.start();

    const dataRoot = mkdtempSync(join(tmpdir(), 'rc-w-'));
    const wPort = await pickPort();
    const env = makeTestWorkerEnv(dataRoot);
    const worker = new Worker<TestEntry>({ env });
    const daemon = new WorkerDaemon<TestEntry>({
      worker, workerId: 'rc-w', port: wPort, bindHost: '127.0.0.1',
      resolveSpec: (wire) => ({
        agentId: wire.agentId,
        workspace: wire.workspace.includes('/') ? wire.workspace : join(agentsRoot, wire.workspace),
        home: new AgentHome(wire.workspace.includes('/') ? wire.workspace : join(agentsRoot, wire.workspace)),
        projectRoot: wire.projectRoot,
        model: wire.model,
        ensureDefaultMcpConfig: false,
      }),
    });
    const dInfo = await daemon.start();
    const reg = new WorkerRegistrationClient({
      a8sUrl: a8s1Info.url, workerId: 'rc-w', callbackUrl: dInfo.callbackUrl,
      capacity: 4, heartbeatTtlMs: 30_000, adminToken: 'rc-secret',
      mountedAgentsProvider: () => worker.ids(),
    });
    await reg.register();
    daemon.setAuthToken((await reg.register()).workerToken); // second call to refresh after restart not used here

    // Create an agent through a8s.
    const createResp = await fetch(`${a8s1Info.url}${A8S_PATHS.agents}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...adminHeaders },
      body: JSON.stringify(createAgentRequestSchema.parse({
        spec: { agentId: 'rc-a', workspace: 'rc-a', model: 'tier:strong', ensureDefaultMcpConfig: false },
        entry: { tag: 'rc' },
      })),
    });
    expect(createResp.status).toBe(200);
    expect(worker.has('rc-a')).toBe(true);

    // ---- Simulated a8s catastrophic restart: stop a8s1, start a8s2 on the
    //      same port with a FRESH store. Worker keeps running. ----
    await a8s1.stop();
    // wait for port release
    await new Promise((r) => setTimeout(r, 100));

    const orch2 = new RuntimeOrchestrator({ store: new MemoryRuntimeOrchestrationStore() });
    const a8s2 = new A8sServer<TestEntry>({
      port: a8sPort, controlPlane: { orchestrator: orch2 }, adminToken: 'rc-secret',
    });
    await a8s2.start();

    // Worker's existing heartbeat will get 404 (a8s2 doesn't know rc-w)
    // and auto-re-register, this time reporting mountedAgents: ['rc-a'].
    // Trigger this by manually re-registering (production flow uses the
    // heartbeat → 404 → re-register path; we shortcut here for determinism).
    const reg2Result = await reg.register();
    expect(reg2Result.ownedAgents).toContain('rc-a');

    // a8s2 now knows about rc-a → rc-w binding.
    const locResp = await fetch(`${a8s1Info.url}${A8S_PATHS.agents}`, { headers: adminHeaders });
    const loc = listAgentsResponseSchema.parse(await locResp.json());
    expect(loc.agents.find((a) => a.agentId === 'rc-a')?.workerId).toBe('rc-w');

    await reg.withdraw(true);
    await daemon.stop();
    await worker.dispose();
    await a8s2.stop();
  });

  it('exposes /metrics in Prometheus text format', async () => {
    const orchestrator = new RuntimeOrchestrator({
      store: new MemoryRuntimeOrchestrationStore(),
    });
    const a8sPort = await pickPort();
    const a8s = new A8sServer<TestEntry>({
      port: a8sPort, controlPlane: { orchestrator }, adminToken: 'm-secret',
    });
    const a8sInfo = await a8s.start();
    // Generate one request that's counted: hit health.
    await fetch(`${a8sInfo.url}${A8S_PATHS.health}`);
    const resp = await fetch(`${a8sInfo.url}/metrics`);
    expect(resp.status).toBe(200);
    expect(resp.headers.get('content-type')).toMatch(/text\/plain/);
    const body = await resp.text();
    // Prometheus exposition: HELP/TYPE lines + sample lines.
    expect(body).toContain('# HELP a8s_requests_total');
    expect(body).toContain('# TYPE a8s_requests_total counter');
    expect(body).toContain('a8s_request_duration_seconds');
    expect(body).toContain('a8s_agents_total');
    await a8s.stop();
  });

  it('operator wake API: list + cancel', async () => {
    const orchestrator = new RuntimeOrchestrator({
      store: new MemoryRuntimeOrchestrationStore(),
    });
    const a8sPort = await pickPort();
    const a8s = new A8sServer<TestEntry>({
      port: a8sPort, controlPlane: { orchestrator }, adminToken: 'w-secret',
      // Disable the wake-delivery loop so the wake stays pending for us to inspect.
      wakeTickMs: 0,
    });
    const a8sInfo = await a8s.start();
    const adminHeaders = { authorization: 'Bearer w-secret' };

    // Schedule a wake far in the future so it doesn't auto-claim.
    const schedResp = await fetch(`${a8sInfo.url}${A8S_PATHS.wakesSchedule}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...adminHeaders },
      body: JSON.stringify({
        agentId: 'op-w-a',
        dueAt: Date.now() + 60_000_000,
        reason: 'op-test',
      }),
    });
    expect(schedResp.status).toBe(200);
    const { wakeId } = await schedResp.json() as { wakeId: string };

    // List shows it.
    const listResp = await fetch(`${a8sInfo.url}/v1/operator/wakes`, { headers: adminHeaders });
    expect(listResp.status).toBe(200);
    const list = await listResp.json() as { wakes: Array<{ wakeId: string; state: string }> };
    const found = list.wakes.find((w) => w.wakeId === wakeId);
    expect(found).toBeDefined();
    expect(found!.state).toBe('pending');

    // Cancel.
    const cancelResp = await fetch(`${a8sInfo.url}/v1/operator/wakes/${wakeId}`, {
      method: 'DELETE',
      headers: adminHeaders,
    });
    expect(cancelResp.status).toBe(200);

    // 404 on unknown.
    const ghostResp = await fetch(`${a8sInfo.url}/v1/operator/wakes/ghost`, {
      method: 'DELETE',
      headers: adminHeaders,
    });
    expect(ghostResp.status).toBe(404);

    await a8s.stop();
  });

  it('machine layer: connector registers, a8s brokers exec, operator lists it', async () => {
    const orchestrator = new RuntimeOrchestrator({ store: new MemoryRuntimeOrchestrationStore() });
    const a8sPort = await pickPort();
    const a8s = new A8sServer<TestEntry>({
      port: a8sPort,
      controlPlane: { orchestrator },
      adminToken: 'mach-secret',
    });
    const a8sInfo = await a8s.start();
    const adminHeaders = { authorization: 'Bearer mach-secret', 'content-type': 'application/json' };

    // ---- Bring up a real machine connector on a random port ----
    const machinePort = await pickPort();
    const connector = new MachineConnectorDaemon({
      machineId: 'mac-1',
      port: machinePort,
      bindHost: '127.0.0.1',
    });
    const cInfo = await connector.start();

    const reg = new MachineRegistrationClient({
      a8sUrl: a8sInfo.url,
      machineId: 'mac-1',
      callbackUrl: cInfo.callbackUrl,
      heartbeatTtlMs: 30_000,
      platform: 'macos',
      adminToken: 'mach-secret',
    });
    const regResult = await reg.register();
    connector.setAuthToken(regResult.machineToken);

    // ---- Operator sees the machine as active ----
    const listResp = await fetch(`${a8sInfo.url}${A8S_PATHS.operatorMachines}`, { headers: adminHeaders });
    const list = await listResp.json() as { machines: Array<{ machineId: string; state: string; platform?: string }> };
    const found = list.machines.find((m) => m.machineId === 'mac-1');
    expect(found).toBeDefined();
    expect(found!.state).toBe('active');
    expect(found!.platform).toBe('macos');

    // ---- a8s brokers an exec to the machine (caller never sees machine token) ----
    const execResp = await fetch(`${a8sInfo.url}/v1/machines/mac-1/exec`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ command: 'echo via-a8s-broker', cwd: process.cwd(), env: {} }),
    });
    expect(execResp.status).toBe(200);
    const execReply = await execResp.json() as { output: string; isError: boolean };
    expect(execReply.isError).toBe(false);
    expect(execReply.output).toContain('via-a8s-broker');

    // ---- exec to unknown machine → 404 ----
    const ghost = await fetch(`${a8sInfo.url}/v1/machines/ghost/exec`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ command: 'echo x', cwd: process.cwd(), env: {} }),
    });
    expect(ghost.status).toBe(404);

    await reg.withdraw();
    await connector.stop();
    await a8s.stop();
  });

  it('machine layer: operator sets a machine\'s MCP — a8s writes .mcp.json over exec + reloads', async () => {
    const orchestrator = new RuntimeOrchestrator({ store: new MemoryRuntimeOrchestrationStore() });
    const a8sPort = await pickPort();
    const a8s = new A8sServer<TestEntry>({
      port: a8sPort,
      controlPlane: { orchestrator },
      adminToken: 'recipe-secret',
      auditRoot: mkdtempSync(join(tmpdir(), 'a8s-recipe-store-')),
    });
    const a8sInfo = await a8s.start();
    const adminHeaders = { authorization: 'Bearer recipe-secret', 'content-type': 'application/json' };

    // Connector reports where its .mcp.json lives so a8s knows where to write.
    const machineDir = mkdtempSync(join(tmpdir(), 'a8s-land-'));
    const mcpConfigPath = join(machineDir, '.mcp.json');
    const machinePort = await pickPort();
    const connector = new MachineConnectorDaemon({
      machineId: 'land-1',
      port: machinePort,
      bindHost: '127.0.0.1',
    });
    const cInfo = await connector.start();
    const reg = new MachineRegistrationClient({
      a8sUrl: a8sInfo.url,
      machineId: 'land-1',
      callbackUrl: cInfo.callbackUrl,
      heartbeatTtlMs: 30_000,
      adminToken: 'recipe-secret',
      mcpConfigPath,
    });
    connector.setAuthToken((await reg.register()).machineToken);

    // ---- Operator sets the machine's MCP servers (the single source) ----
    const setResp = await fetch(
      `${a8sInfo.url}/v1/operator/machines/land-1/mcp-config`,
      {
        method: 'POST',
        headers: adminHeaders,
        body: JSON.stringify({
          mcpServers: { playwright: { command: 'npx', args: ['-y', '@playwright/mcp@latest', '--headless'] } },
          installCommands: [],
        }),
      },
    );
    expect(setResp.status).toBe(200);
    const set = await setResp.json() as { configPath: string; machineId: string };
    expect(set.machineId).toBe('land-1');
    expect(set.configPath).toBe(mcpConfigPath);

    // ---- a8s wrote the .mcp.json on the machine over the exec broker ----
    expect(existsSync(mcpConfigPath)).toBe(true);
    const written = JSON.parse(readFileSync(mcpConfigPath, 'utf-8')) as { mcpServers: Record<string, unknown> };
    expect(written.mcpServers.playwright).toBeDefined();

    // ---- Reading it back returns the same map ----
    const getResp = await fetch(`${a8sInfo.url}/v1/operator/machines/land-1/mcp-config`, { headers: adminHeaders });
    expect(getResp.status).toBe(200);
    const got = await getResp.json() as { mcpServers: Record<string, unknown> };
    expect(got.mcpServers.playwright).toBeDefined();

    // ---- A Hand recipe references the machine + its server (no MCP config) ----
    const regResp = await fetch(`${a8sInfo.url}${A8S_PATHS.operatorHandRecipes}`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ id: 'pw', name: 'Playwright', machineId: 'land-1', mcpServerRefs: ['playwright'] }),
    });
    expect(regResp.status).toBe(200);
    const listResp = await fetch(`${a8sInfo.url}${A8S_PATHS.operatorHandRecipes}`, { headers: adminHeaders });
    const { recipes } = await listResp.json() as { recipes: Array<{ id: string; mcpServerRefs: string[] }> };
    const pw = recipes.find((r) => r.id === 'pw');
    expect(pw?.mcpServerRefs).toEqual(['playwright']);

    // ---- Setting MCP on an unknown machine → 404 ----
    const ghost = await fetch(
      `${a8sInfo.url}/v1/operator/machines/ghost/mcp-config`,
      { method: 'POST', headers: adminHeaders, body: JSON.stringify({ mcpServers: {} }) },
    );
    expect(ghost.status).toBe(404);

    await reg.withdraw();
    await connector.stop();
    await a8s.stop();
  });

  it('machine layer: an agent with labels.machines gets a machine exec tool that reaches the connector', async () => {
    const orchestrator = new RuntimeOrchestrator({ store: new MemoryRuntimeOrchestrationStore() });
    const a8sPort = await pickPort();
    const a8s = new A8sServer<TestEntry>({
      port: a8sPort,
      controlPlane: { orchestrator },
      adminToken: 'mix-secret',
    });
    const a8sInfo = await a8s.start();

    // Real worker whose resolveSpec injects machine tools by label
    // (withMachineHostTools — the same wrapper the berry-worker CLI uses).
    const root = mkdtempSync(join(tmpdir(), 'a8s-mix-'));
    const w = await startTestWorker({ a8sUrl: a8sInfo.url, adminToken: 'mix-secret', workerId: 'w-mix', root });

    // A real connector for machine "mac-1".
    const machinePort = await pickPort();
    const connector = new MachineConnectorDaemon({ machineId: 'mac-1', port: machinePort, bindHost: '127.0.0.1' });
    const cInfo = await connector.start();
    const reg = new MachineRegistrationClient({
      a8sUrl: a8sInfo.url,
      machineId: 'mac-1',
      callbackUrl: cInfo.callbackUrl,
      heartbeatTtlMs: 30_000,
      adminToken: 'mix-secret',
    });
    connector.setAuthToken((await reg.register()).machineToken);

    // Create an agent that declares it operates mac-1.
    await a8s.plane.createAgent(
      {
        agentId: 'operator-agent',
        workspace: 'operator-agent',
        model: 'tier:strong',
        ensureDefaultMcpConfig: false,
        labels: { machines: 'mac-1' },
      },
      { tag: 'mix' } as never,
    );

    // The mounted agent should expose the machine exec tool. (That the
    // tool actually reaches the connector through the a8s broker is
    // covered by the broker e2e above + the a8s-admin unit test; here we
    // assert the label-driven injection wiring end-to-end.)
    const mount = w.worker.get('operator-agent');
    expect(mount).toBeDefined();
    const toolNames = new Set(mount!.runtime.getTools().map((t) => t.name));
    expect(toolNames.has('machine_mac-1_exec')).toBe(true);

    await reg.withdraw();
    await connector.stop();
    await w.stop();
    await a8s.stop();
  });

  it('scoped tenancy: a product only sees/drives its own agents; operator sees all', async () => {
    const orchestrator = new RuntimeOrchestrator({ store: new MemoryRuntimeOrchestrationStore() });
    const a8sPort = await pickPort();
    const a8s = new A8sServer<TestEntry>({ port: a8sPort, controlPlane: { orchestrator }, adminToken: 'op-secret' });
    const a8sInfo = await a8s.start();
    const root = mkdtempSync(join(tmpdir(), 'wd-tenancy-'));
    const w = await startTestWorker({ a8sUrl: a8sInfo.url, adminToken: 'op-secret', workerId: 'w-ten', root });

    // Operator issues two product tokens.
    const tokenA = a8s.products.issue('prod-a').token;
    const tokenB = a8s.products.issue('prod-b').token;
    const hdr = (t: string) => ({ headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' } });

    // Product A creates an agent (owner stamped from its scope).
    const createA = await fetch(`${a8sInfo.url}${A8S_PATHS.agents}`, {
      method: 'POST',
      ...hdr(tokenA),
      body: JSON.stringify(createAgentRequestSchema.parse({
        spec: { agentId: 'a-of-A', workspace: 'a-of-A', model: 'tier:strong', ensureDefaultMcpConfig: false },
        entry: { tag: 'A' },
      })),
    });
    expect(createA.status).toBe(200);

    // A sees its agent; B sees none; operator sees it.
    const listA = listAgentsResponseSchema.parse(await fetch(`${a8sInfo.url}${A8S_PATHS.agents}`, hdr(tokenA)).then((r) => r.json()));
    expect(listA.agents.map((x) => x.agentId)).toContain('a-of-A');
    const listB = listAgentsResponseSchema.parse(await fetch(`${a8sInfo.url}${A8S_PATHS.agents}`, hdr(tokenB)).then((r) => r.json()));
    expect(listB.agents.map((x) => x.agentId)).not.toContain('a-of-A');
    const listOp = listAgentsResponseSchema.parse(await fetch(`${a8sInfo.url}${A8S_PATHS.agents}`, { headers: { authorization: 'Bearer op-secret' } }).then((r) => r.json()));
    expect(listOp.agents.map((x) => x.agentId)).toContain('a-of-A');

    // B cannot read or delete A's agent (404, not 403 — no existence leak).
    const getB = await fetch(`${a8sInfo.url}${A8S_PATHS.agent('a-of-A')}`, hdr(tokenB));
    expect(getB.status).toBe(404);
    const delB = await fetch(`${a8sInfo.url}${A8S_PATHS.agent('a-of-A')}`, { method: 'DELETE', ...hdr(tokenB) });
    expect(delB.status).toBe(404);

    // A can read its own agent, and the owner is reported.
    const getA = await fetch(`${a8sInfo.url}${A8S_PATHS.agent('a-of-A')}`, hdr(tokenA));
    expect(getA.status).toBe(200);
    expect((await getA.json()).owner).toBe('prod-a');

    // An unknown token is rejected outright.
    const bad = await fetch(`${a8sInfo.url}${A8S_PATHS.agents}`, { headers: { authorization: 'Bearer bp_nope' } });
    expect(bad.status).toBe(401);

    await w.stop();
    await a8s.stop();
  });

  it('usage read path: per-agent usage proxies to the owning worker; operator rollup fans in + aggregates by product', async () => {
    const orchestrator = new RuntimeOrchestrator({ store: new MemoryRuntimeOrchestrationStore() });
    const a8sPort = await pickPort();
    const a8s = new A8sServer<TestEntry>({ port: a8sPort, controlPlane: { orchestrator }, adminToken: 'op-secret' });
    const a8sInfo = await a8s.start();
    const root = mkdtempSync(join(tmpdir(), 'wd-usage-'));
    const w = await startTestWorker({ a8sUrl: a8sInfo.url, adminToken: 'op-secret', workerId: 'w-usage', root });

    // Product A creates an agent (owner stamped from its scope).
    const tokenA = a8s.products.issue('prod-a').token;
    const createA = await fetch(`${a8sInfo.url}${A8S_PATHS.agents}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${tokenA}`, 'content-type': 'application/json' },
      body: JSON.stringify(createAgentRequestSchema.parse({
        spec: { agentId: 'a-usage', workspace: 'a-usage', model: 'tier:strong', ensureDefaultMcpConfig: false },
        entry: { tag: 'A' },
      })),
    });
    expect(createA.status).toBe(200);

    // Per-agent usage proxies to the owning worker. No real inference has run,
    // so observe.db has nothing recorded → present:false, usage:null. The
    // point is the a8s → worker → observe wiring round-trips and validates.
    const perAgent = await fetch(`${a8sInfo.url}${A8S_PATHS.agentUsage('a-usage')}`, {
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(perAgent.status).toBe(200);
    const perAgentBody = agentUsageResponseSchema.parse(await perAgent.json());
    expect(perAgentBody.present).toBe(false);
    expect(perAgentBody.usage).toBeNull();

    // Operator rollup fans in over all agents and aggregates upward. With no
    // recorded usage the agent rows are empty but the envelope is well-formed.
    const op = await fetch(`${a8sInfo.url}${A8S_PATHS.operatorUsage}`, {
      headers: { authorization: 'Bearer op-secret' },
    });
    expect(op.status).toBe(200);
    const opBody = operatorUsageResponseSchema.parse(await op.json());
    expect(opBody.totals.totalCost).toBe(0);
    expect(Array.isArray(opBody.agents)).toBe(true);
    expect(Array.isArray(opBody.byProduct)).toBe(true);

    // A product token cannot reach the operator rollup.
    const opAsProduct = await fetch(`${a8sInfo.url}${A8S_PATHS.operatorUsage}`, {
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(opAsProduct.status).toBe(401);

    // Drill-down read path: session → turn → inference → detail all proxy to
    // the owning worker's observe.db. Nothing's recorded, so the lists are
    // empty and the detail is present:false — the point is each level round-
    // trips through a8s → worker → observe and validates against its schema.
    const sessions = await fetch(`${a8sInfo.url}${A8S_PATHS.agentUsageSessions('a-usage')}`, {
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(sessions.status).toBe(200);
    expect(usageSessionListResponseSchema.parse(await sessions.json()).sessions).toEqual([]);

    const turns = await fetch(`${a8sInfo.url}${A8S_PATHS.agentUsageTurns('a-usage', 'sess-x')}`, {
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(turns.status).toBe(200);
    expect(usageTurnListResponseSchema.parse(await turns.json()).turns).toEqual([]);

    const infs = await fetch(`${a8sInfo.url}${A8S_PATHS.agentUsageInferences('a-usage', 'turn-x')}`, {
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(infs.status).toBe(200);
    expect(usageInferenceListResponseSchema.parse(await infs.json()).inferences).toEqual([]);

    const detail = await fetch(`${a8sInfo.url}${A8S_PATHS.agentUsageInferenceDetail('a-usage', 'inf-x')}`, {
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(detail.status).toBe(200);
    const detailBody = usageInferenceDetailResponseSchema.parse(await detail.json());
    expect(detailBody.present).toBe(false);
    expect(detailBody.inference).toBeNull();

    await w.stop();
    await a8s.stop();
  });

  it('machine join-script: refuses in dev mode, embeds admin token + connector install otherwise', async () => {
    // Dev mode → refuse.
    const orchA = new RuntimeOrchestrator({ store: new MemoryRuntimeOrchestrationStore() });
    const portA = await pickPort();
    const a8sA = new A8sServer<TestEntry>({ port: portA, controlPlane: { orchestrator: orchA } });
    const infoA = await a8sA.start();
    const devResp = await fetch(`${infoA.url}${A8S_PATHS.operatorMachineJoinScript}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(devResp.status).toBe(409);
    await a8sA.stop();

    // With admin token → embeds it + advertiseUrl + the connector install.
    const orchB = new RuntimeOrchestrator({ store: new MemoryRuntimeOrchestrationStore() });
    const portB = await pickPort();
    const a8sB = new A8sServer<TestEntry>({
      port: portB,
      controlPlane: { orchestrator: orchB },
      adminToken: 'join-secret',
      advertiseUrl: 'https://a8s.example.com',
    });
    const infoB = await a8sB.start();
    const respB = await fetch(`${infoB.url}${A8S_PATHS.operatorMachineJoinScript}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer join-secret' },
      body: JSON.stringify({ machineId: 'office-mac', port: 7250 }),
    });
    expect(respB.status).toBe(200);
    const bodyB = await respB.json() as { script: string; resolved: { machineId: string; port: number; a8sUrl: string } };
    expect(bodyB.script).toContain('@berry-agent/machine-connector');
    expect(bodyB.script).toContain('join-secret');
    expect(bodyB.script).toContain('https://a8s.example.com');
    expect(bodyB.script).toContain('office-mac');
    expect(bodyB.resolved.port).toBe(7250);
    await a8sB.stop();
  });
});
