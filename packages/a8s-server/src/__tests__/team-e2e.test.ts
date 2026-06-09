// ============================================================
// E2E: emergent-team resources over real HTTP
// ============================================================
// The team's shared state (worklist + message log) lives in a8s, project-
// scoped. This exercises the full wire: create the worklist, claim/patch a
// task, append + read messages, and confirm membership-by-label (listAgents
// surfaces labels.project). a8s holds the state in TeamStore; no worker is
// involved for these resources.

import { describe, expect, it, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RuntimeOrchestrator, MemoryRuntimeOrchestrationStore } from '@berry-agent/runtime';
import { A8S_PATHS, ADMIN_AUTH_HEADER, adminAuthHeader } from '@berry-agent/cluster-protocol';
import { A8sServer } from '../server.js';

async function pickPort(): Promise<number> {
  const net = await import('node:net');
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

let running: A8sServer | null = null;
afterEach(async () => { await running?.stop(); running = null; });

const TOKEN = 'tok';
async function boot(): Promise<string> {
  const orchestrator = new RuntimeOrchestrator({ store: new MemoryRuntimeOrchestrationStore() });
  const auditRoot = join(mkdtempSync(join(tmpdir(), 'team-e2e-')), 'audit');
  const server = new A8sServer({ port: await pickPort(), controlPlane: { orchestrator }, adminToken: TOKEN, auditRoot });
  running = server;
  const info = await server.start();
  return info.url;
}

function authed(method: string, body?: unknown): RequestInit {
  return {
    method,
    headers: { [ADMIN_AUTH_HEADER]: adminAuthHeader(TOKEN), 'content-type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  };
}

describe('emergent-team resources E2E', () => {
  it('worklist: add → list → patch (claim + done) round-trips', async () => {
    const url = await boot();
    const project = '/code/acme';

    // Add a task.
    const addRes = await fetch(`${url}${A8S_PATHS.projectWorklist(project)}`, authed('POST', {
      title: 'Wire the login form', createdBy: '@leader',
    }));
    expect(addRes.status).toBe(200);
    const task = await addRes.json();
    expect(task.id).toBeTruthy();
    expect(task.status).toBe('unclaimed');

    // List shows it.
    const listRes = await fetch(`${url}${A8S_PATHS.projectWorklist(project)}`, authed('GET'));
    const { tasks } = await listRes.json();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].title).toBe('Wire the login form');

    // Claim then complete.
    const claimRes = await fetch(`${url}${A8S_PATHS.projectWorklistTask(project, task.id)}`, authed('PATCH', {
      status: 'claimed', assignee: 'coder-1',
    }));
    expect((await claimRes.json()).assignee).toBe('coder-1');
    const doneRes = await fetch(`${url}${A8S_PATHS.projectWorklistTask(project, task.id)}`, authed('PATCH', { status: 'done' }));
    const done = await doneRes.json();
    expect(done.status).toBe('done');
    expect(done.completedAt).toBeGreaterThan(0);
  });

  it('patch on a missing task is 404', async () => {
    const url = await boot();
    const res = await fetch(`${url}${A8S_PATHS.projectWorklistTask('/p', 'nope')}`, authed('PATCH', { status: 'done' }));
    expect(res.status).toBe(404);
  });

  it('messages: append → read in order, server stamps id/ts', async () => {
    const url = await boot();
    const project = '/code/acme';
    await fetch(`${url}${A8S_PATHS.projectMessages(project)}`, authed('POST', { from: 'coder-1', to: '@leader', content: 'task done' }));
    await fetch(`${url}${A8S_PATHS.projectMessages(project)}`, authed('POST', { from: '@leader', to: '@broadcast', content: 'nice' }));
    const res = await fetch(`${url}${A8S_PATHS.projectMessages(project)}`, authed('GET'));
    const { messages } = await res.json();
    expect(messages).toHaveLength(2);
    expect(messages[0].content).toBe('task done');
    expect(messages[0].id).toBeTruthy();
    expect(messages[0].ts).toBeGreaterThan(0);
    expect(messages[1].to).toBe('@broadcast');
  });

  it('worklist of different projects are isolated', async () => {
    const url = await boot();
    await fetch(`${url}${A8S_PATHS.projectWorklist('/a')}`, authed('POST', { title: 'a-task', createdBy: '@leader' }));
    const bList = await (await fetch(`${url}${A8S_PATHS.projectWorklist('/b')}`, authed('GET'))).json();
    expect(bList.tasks).toHaveLength(0);
  });

  it('requires the admin token', async () => {
    const url = await boot();
    const res = await fetch(`${url}${A8S_PATHS.projectWorklist('/p')}`); // no auth
    expect(res.status).toBe(401);
  });
});
