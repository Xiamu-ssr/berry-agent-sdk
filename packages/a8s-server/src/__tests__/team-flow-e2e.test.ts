// ============================================================
// E2E: emergent-team end-to-end over real HTTP (a8s + worker)
// ============================================================
// Proves the label-driven team wiring lands on a real worker:
//   1. Create a leader agent (labels.team + role:leader) over HTTP.
//   2. Drive its spawn_teammate tool — which POSTs /v1/agents — and confirm
//      the teammate mounts on the worker with the *teammate* toolset.
//   3. Confirm membership-by-label via listAgents (both share the project).
//   4. Run the leader worklist_add + teammate claim_task tools against the
//      live a8s worklist and confirm the state machine round-trips.
//
// The worker daemon is wrapped with the SAME withTeamModeHostTools the
// production berry-worker CLI applies. The test resolves an agent's tools
// through that exact resolveSpec (it is pure), so the executors under test are
// the real injected ones — and they make genuine HTTP calls to the live a8s.
// The mounted runtime only exposes tool *definitions* (no executors), so we
// also assert the toolset by name straight off the worker's mounted runtime.

import { describe, expect, it, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  A8S_PATHS,
  ADMIN_AUTH_HEADER,
  adminAuthHeader,
  createAgentRequestSchema,
} from '@berry-agent/cluster-protocol';
import { AgentHome } from '@berry-agent/core';
import { MemoryRuntimeOrchestrationStore, RuntimeOrchestrator } from '@berry-agent/runtime';
import { Worker } from '@berry-agent/worker';
import { makeTestWorkerEnv } from '@berry-agent/worker/test-utils';
import {
  WorkerDaemon,
  WorkerRegistrationClient,
  withTeamModeHostTools,
  type WireResolveInput,
} from '@berry-agent/worker-daemon';
import type { WorkerAgentSpec } from '@berry-agent/worker';
import { A8sServer } from '../server.js';

interface TestEntry { role?: string }

async function pickPort(): Promise<number> {
  const net = await import('node:net');
  return new Promise((resolve) => {
    const s = net.createServer();
    s.unref();
    s.listen(0, () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

const TOKEN = 'tok';
const stops: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const stop of stops.splice(0).reverse()) await stop().catch(() => {});
});

interface Booted {
  url: string;
  worker: Worker<TestEntry>;
  resolveSpec: (wire: WireResolveInput) => WorkerAgentSpec;
}

async function boot(): Promise<Booted> {
  const orchestrator = new RuntimeOrchestrator({ store: new MemoryRuntimeOrchestrationStore() });
  const auditRoot = join(mkdtempSync(join(tmpdir(), 'team-flow-')), 'audit');
  const server = new A8sServer<TestEntry>({
    port: await pickPort(),
    controlPlane: { orchestrator },
    adminToken: TOKEN,
    auditRoot,
    wakeTickMs: 0, // we drive tools directly; no need for the wake loop here
  });
  const info = await server.start();
  stops.push(() => server.stop());

  const root = mkdtempSync(join(tmpdir(), 'team-flow-w-'));
  const agentsRoot = join(root, 'agents');
  const env = makeTestWorkerEnv(root);
  const worker = new Worker<TestEntry>({ env });
  const base = (wire: WireResolveInput): WorkerAgentSpec => {
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
  const resolveSpec = withTeamModeHostTools(base, { a8sUrl: info.url, adminToken: TOKEN });
  const daemon = new WorkerDaemon<TestEntry>({
    worker, workerId: 'tw-1', port: await pickPort(), bindHost: '127.0.0.1', resolveSpec,
  });
  const dInfo = await daemon.start();
  const reg = new WorkerRegistrationClient({
    a8sUrl: info.url, workerId: 'tw-1', callbackUrl: dInfo.callbackUrl,
    capacity: 8, heartbeatTtlMs: 30_000, adminToken: TOKEN,
  });
  daemon.setAuthToken((await reg.register()).workerToken);
  stops.push(async () => { await reg.withdraw(true).catch(() => {}); await daemon.stop(); await worker.dispose(); });

  return { url: info.url, worker, resolveSpec };
}

function authed(method: string, body?: unknown): RequestInit {
  return {
    method,
    headers: { [ADMIN_AUTH_HEADER]: adminAuthHeader(TOKEN), 'content-type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  };
}

/** Tool *definitions* mounted on the live runtime (no executors here). */
function mountedToolNames(worker: Worker<TestEntry>, agentId: string): string[] {
  return worker.runtime(agentId).getTools().map((t) => t.name);
}

/** Resolve an agent's executable team tools through the real resolveSpec. */
function teamTool(booted: Booted, agentId: string, labels: Record<string, string>, project: string, name: string) {
  const spec = booted.resolveSpec({ agentId, workspace: agentId, projectRoot: project, model: 'tier:strong', labels });
  const tool = (spec.hostTools ?? []).find((t) => t.definition.name === name);
  if (!tool) throw new Error(`no tool ${name}; has: ${(spec.hostTools ?? []).map((t) => t.definition.name).join(', ')}`);
  return tool;
}

async function createAgentHttp(url: string, agentId: string, role: string, leader: string, project: string): Promise<void> {
  const body = createAgentRequestSchema.parse({
    spec: {
      agentId, workspace: agentId, projectRoot: project, model: 'tier:strong',
      ensureDefaultMcpConfig: false,
      labels: { team: 'true', role, leader, project },
    },
    entry: { role },
  });
  const r = await fetch(`${url}${A8S_PATHS.agents}`, authed('POST', body));
  if (r.status !== 200) throw new Error(`create ${agentId} → HTTP ${r.status}: ${await r.text()}`);
}

async function listWorklist(url: string, project: string): Promise<Array<{ id: string; status: string; assignee?: string }>> {
  const res = await fetch(`${url}${A8S_PATHS.projectWorklist(project)}`, authed('GET'));
  return (await res.json()).tasks;
}

describe('emergent-team end-to-end (a8s + worker)', () => {
  it('leader spawns a teammate, both mount with the right toolset, share the project', async () => {
    const booted = await boot();
    const { url, worker } = booted;
    const project = mkdtempSync(join(tmpdir(), 'team-proj-'));
    const leaderLabels = { team: 'true', role: 'leader', leader: 'lead', project };

    // ---- Create the leader over HTTP (role:leader) ----
    await createAgentHttp(url, 'lead', 'leader', 'lead', project);
    expect(worker.has('lead')).toBe(true);

    // Leader mounts the command tools, not the teammate loop.
    const leadTools = mountedToolNames(worker, 'lead');
    expect(leadTools).toEqual(expect.arrayContaining(['spawn_teammate', 'list_team', 'worklist_add']));
    expect(leadTools).not.toContain('claim_task');

    // ---- Leader spawns a teammate via its real tool (POSTs /v1/agents) ----
    const spawn = teamTool(booted, 'lead', leaderLabels, project, 'spawn_teammate');
    const spawnRes = await spawn.execute(
      { role: 'reviewer', systemPrompt: 'Review the diffs.', agentId: 'reviewer-1' },
      { cwd: project },
    );
    expect(spawnRes.isError).not.toBe(true);
    expect(worker.has('reviewer-1')).toBe(true);

    // Teammate mounts the report-up loop, not the command tools.
    const tmTools = mountedToolNames(worker, 'reviewer-1');
    expect(tmTools).toEqual(expect.arrayContaining(['message_leader', 'claim_task', 'update_task', 'read_worklist']));
    expect(tmTools).not.toContain('spawn_teammate');

    // ---- Membership by label via the leader's list_team tool ----
    const list = teamTool(booted, 'lead', leaderLabels, project, 'list_team');
    const listRes = await list.execute({}, { cwd: project });
    expect(listRes.content).toContain('lead');
    expect(listRes.content).toContain('reviewer-1');
  });

  it('leader adds a worklist task; teammate claims it; state round-trips in a8s', async () => {
    const booted = await boot();
    const { url } = booted;
    const project = mkdtempSync(join(tmpdir(), 'team-proj-'));
    const leaderLabels = { team: 'true', role: 'leader', leader: 'lead', project };
    const coderLabels = { team: 'true', role: 'coder', leader: 'lead', project };

    await createAgentHttp(url, 'lead', 'leader', 'lead', project);
    await createAgentHttp(url, 'coder-1', 'coder', 'lead', project);

    // Leader posts a task.
    const add = teamTool(booted, 'lead', leaderLabels, project, 'worklist_add');
    expect((await add.execute({ title: 'Wire the login form' }, { cwd: project })).isError).not.toBe(true);

    // The task is visible + unclaimed in a8s.
    let tasks = await listWorklist(url, project);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].status).toBe('unclaimed');
    const taskId = tasks[0].id;

    // Teammate claims it via its real tool.
    const claim = teamTool(booted, 'coder-1', coderLabels, project, 'claim_task');
    expect((await claim.execute({ taskId }, { cwd: project })).isError).not.toBe(true);

    tasks = await listWorklist(url, project);
    expect(tasks[0].status).toBe('claimed');
    expect(tasks[0].assignee).toBe('coder-1');

    // Teammate completes it.
    const update = teamTool(booted, 'coder-1', coderLabels, project, 'update_task');
    await update.execute({ taskId, status: 'done' }, { cwd: project });
    tasks = await listWorklist(url, project);
    expect(tasks[0].status).toBe('done');
  });
});
