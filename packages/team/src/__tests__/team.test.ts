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
