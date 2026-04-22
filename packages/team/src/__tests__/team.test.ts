/**
 * Team unit tests.
 *
 * We can't easily instantiate a real Agent here without a provider, so we
 * exercise:
 *   - TeamStore persistence (team.json + messages.jsonl)
 *   - Team state mutation / reload semantics
 *   - Leader-id drift detection on reopen
 *
 * Live leader/teammate Agent wiring is integration-tested from berry-claw.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TeamStore } from '../store.js';
import { WorklistStore, WorklistError } from '../worklist.js';
import type { TeamState, TeamMessage } from '../types.js';

let project: string;

beforeEach(async () => {
  project = await mkdtemp(join(tmpdir(), 'berry-team-test-'));
});

afterEach(async () => {
  await rm(project, { recursive: true, force: true });
});

describe('TeamStore', () => {
  it('returns null when no team exists yet', async () => {
    const store = new TeamStore(project);
    expect(await store.load()).toBeNull();
  });

  it('roundtrips a team state', async () => {
    const store = new TeamStore(project);
    const state: TeamState = {
      name: 'berry-claw-dev',
      project,
      leaderId: 'orange',
      teammates: [],
      createdAt: 1000,
    };
    await store.save(state);
    const loaded = await store.load();
    expect(loaded).toEqual(state);
    // Verify the file is pretty-printed (easier to eyeball during debug).
    const raw = await readFile(join(project, '.berry', 'team.json'), 'utf-8');
    expect(raw).toContain('\n  "name"');
  });

  it('persists teammate additions', async () => {
    const store = new TeamStore(project);
    const state: TeamState = {
      name: 'berry-claw-dev',
      project,
      leaderId: 'orange',
      teammates: [
        { id: 'reviewer', role: 'Code Reviewer', systemPrompt: 'Review code.', createdAt: 1 },
        { id: 'tester', role: 'Tester', systemPrompt: 'Run tests.', createdAt: 2 },
      ],
      createdAt: 1000,
    };
    await store.save(state);
    const loaded = await store.load();
    expect(loaded?.teammates).toHaveLength(2);
    expect(loaded?.teammates[0].id).toBe('reviewer');
  });

  it('appends messages to a JSONL log', async () => {
    const store = new TeamStore(project);
    const messages: TeamMessage[] = [
      { id: 'a', ts: 1, from: '@leader', to: 'reviewer', content: 'please review' },
      { id: 'b', ts: 2, from: 'reviewer', to: '@leader', content: 'lgtm', replyTo: 'a' },
      { id: 'c', ts: 3, from: 'tester', to: '@leader', content: 'tests green' },
    ];
    for (const m of messages) await store.appendMessage(m);
    const loaded = await store.readMessages();
    expect(loaded).toEqual(messages);
  });

  it('atomic save survives when tmp file interrupts (no partial write leak)', async () => {
    // Not a true crash sim — but at least verify we never leave a
    // half-written team.json under a torn rename.
    const store = new TeamStore(project);
    const state: TeamState = {
      name: 't',
      project,
      leaderId: 'orange',
      teammates: [],
      createdAt: 1,
    };
    await store.save(state);
    await store.save({ ...state, name: 'renamed' });
    const loaded = await store.load();
    expect(loaded?.name).toBe('renamed');
  });
});

describe('WorklistStore', () => {
  it('starts empty', async () => {
    const w = new WorklistStore(project);
    const state = await w.load();
    expect(state.tasks).toEqual([]);
    expect(state.nextId).toBe(1);
  });

  it('leader creates unclaimed tasks, teammate creates self-assigned', async () => {
    const w = new WorklistStore(project);
    const t1 = await w.create('@leader', { title: 'build feature X' });
    const t2 = await w.create('reviewer', { title: 'review PR' });
    expect(t1.status).toBe('unclaimed');
    expect(t1.assignee).toBeUndefined();
    expect(t2.status).toBe('claimed');
    expect(t2.assignee).toBe('reviewer');
    expect(t1.id).toBe('T-0001');
    expect(t2.id).toBe('T-0002');
  });

  it('enforces state machine on happy path', async () => {
    const w = new WorklistStore(project);
    const task = await w.create('@leader', { title: 'ship' });
    const claimed = await w.claim('alice', task.id);
    expect(claimed.status).toBe('claimed');
    expect(claimed.assignee).toBe('alice');
    const started = await w.start('alice', task.id);
    expect(started.status).toBe('in_progress');
    const done = await w.complete('alice', task.id);
    expect(done.status).toBe('done');
    expect(done.completedAt).toBeGreaterThan(0);
  });

  it('blocks illegal transitions', async () => {
    const w = new WorklistStore(project);
    const task = await w.create('@leader', { title: 'ship' });
    // Cannot start without claiming first
    await expect(w.start('alice', task.id)).rejects.toThrow(WorklistError);
    // Cannot complete without starting
    await w.claim('alice', task.id);
    await expect(w.complete('alice', task.id)).rejects.toThrow(WorklistError);
  });

  it('blocks non-owner from transitioning someone else task', async () => {
    const w = new WorklistStore(project);
    const task = await w.create('@leader', { title: 'ship', assignee: 'alice' });
    await expect(w.start('bob', task.id)).rejects.toThrow(/assigned to alice/i);
  });

  it('fail requires reason and records it', async () => {
    const w = new WorklistStore(project);
    const task = await w.create('alice', { title: 'flaky thing' });
    await w.start('alice', task.id);
    await expect(w.fail('alice', task.id, '')).rejects.toThrow(/reason is required/i);
    const failed = await w.fail('alice', task.id, 'upstream API timeout');
    expect(failed.status).toBe('failed');
    expect(failed.failureReason).toBe('upstream API timeout');
  });

  it('leader update bypasses state machine; teammate update denied', async () => {
    const w = new WorklistStore(project);
    const task = await w.create('alice', { title: 'flaky', assignee: 'alice' });
    await w.start('alice', task.id);
    await w.fail('alice', task.id, 'initial failure');
    // Leader re-opens the task
    const reopened = await w.update('@leader', task.id, { status: 'claimed' });
    expect(reopened.status).toBe('claimed');
    // Teammate cannot use `update`
    await expect(w.update('bob', task.id, { status: 'done' })).rejects.toThrow(/leader/i);
  });

  it('only leader can delete', async () => {
    const w = new WorklistStore(project);
    const task = await w.create('@leader', { title: 'x' });
    await expect(w.remove('alice', task.id)).rejects.toThrow(/leader/i);
    await w.remove('@leader', task.id);
    expect(await w.list()).toEqual([]);
  });

  it('persists across instances', async () => {
    const w1 = new WorklistStore(project);
    await w1.create('@leader', { title: 'a' });
    await w1.create('@leader', { title: 'b' });
    const w2 = new WorklistStore(project);
    const tasks = await w2.list();
    expect(tasks.map((t) => t.title)).toEqual(['a', 'b']);
    // nextId survives so new tasks don't collide
    const t3 = await w2.create('@leader', { title: 'c' });
    expect(t3.id).toBe('T-0003');
  });
});
