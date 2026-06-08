// ============================================================
// Workspace initializer — agent.json authority
// ============================================================
//
// These tests pin down the contract:
//
//   - File missing       → fresh metadata composed from seed.
//   - File exists        → read agent.json as the source of truth, untouched.

import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentHome } from '../agent-home.js';
import { initWorkspaceSync, loadAgentConfigSync, saveAgentConfigSync } from '../workspace/initializer.js';

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), 'berry-init-'));
}

function writeAgentJson(root: string, body: Record<string, unknown>): void {
  writeFileSync(new AgentHome(root).metadataPath, JSON.stringify(body, null, 2) + '\n', 'utf-8');
}

describe('initWorkspaceSync — first-time init', () => {
  it('writes a fresh metadata file from seed when agent.json is missing', () => {
    const root = freshDir();
    const meta = initWorkspaceSync(root, {
      model: 'claude-opus-4.7',
      skills: { extraDirs: ['/some/pool'] },
    });

    expect(meta.id).toBeDefined();
    expect(meta.createdAt).toBeDefined();
    expect(meta.model).toBe('claude-opus-4.7');
    expect(meta.skills?.extraDirs).toEqual(['/some/pool']);

    // Persisted to disk
    const home = new AgentHome(root);
    const onDisk = JSON.parse(readFileSync(home.metadataPath, 'utf-8'));
    expect(onDisk.skills?.extraDirs).toEqual(['/some/pool']);
    // Sidecar files exist
    expect(existsSync(home.agentMdPath)).toBe(true);
    expect(existsSync(home.memoryPath)).toBe(true);
    expect(existsSync(home.sessionsDir)).toBe(true);
  });

  it('seeds built-in Hand selection into agent.json so a restart reads it back', () => {
    const root = freshDir();
    const meta = initWorkspaceSync(root, {
      model: 'claude-opus-4.7',
      hands: { builtin: ['workspace'] }, // web disabled at create time
    });
    expect(meta.hands?.builtin).toEqual(['workspace']);

    // Persisted — this is the single source of truth a rehydrate reloads.
    const reloaded = loadAgentConfigSync(root);
    expect(reloaded.hands?.builtin).toEqual(['workspace']);
  });

  it('seeds the classifier model into agent.json so a restart rehydrates it', () => {
    const root = freshDir();
    const meta = initWorkspaceSync(root, {
      model: 'tier:strong',
      classifierModel: 'tier:cheap',
    });
    expect(meta.classifierModel).toBe('tier:cheap');

    // Survives a reload — the daemon reads this back into safety.classifier.model.
    const reloaded = loadAgentConfigSync(root);
    expect(reloaded.classifierModel).toBe('tier:cheap');
  });
});

describe('initWorkspaceSync — on-disk authority is preserved', () => {
  it('does NOT overwrite a field already present on disk, even if seed differs', () => {
    const root = freshDir();
    writeAgentJson(root, {
      id: 'a',
      name: 'a',
      createdAt: '2026-01-01T00:00:00.000Z',
      model: 'claude-opus-4.7', // user picked this — seed must not clobber
      skills: { extraDirs: ['/user/picked'] },
    });

    const meta = initWorkspaceSync(root, {
      model: 'gpt-5', // seed wants something else
      skills: { extraDirs: ['/seed/wanted'] },
    });

    expect(meta.model).toBe('claude-opus-4.7');
    expect(meta.skills?.extraDirs).toEqual(['/user/picked']);
  });

  it('never re-stamps identity fields (id/name/createdAt) — they are immutable post-init', () => {
    const root = freshDir();
    writeAgentJson(root, {
      id: 'engineer',
      name: 'Engineer',
      createdAt: '2026-05-06T10:34:16.652Z',
    });

    // Seed pretends a newer init would change these. They must not move.
    const meta = initWorkspaceSync(root, { model: 'gpt-5' });

    expect(meta.id).toBe('engineer');
    expect(meta.name).toBe('Engineer');
    expect(meta.createdAt).toBe('2026-05-06T10:34:16.652Z');
  });
});

describe('initWorkspaceSync — persistence policy', () => {
  it('does NOT rewrite agent.json when there is nothing to fill (mtime stable)', () => {
    const root = freshDir();
    const body = {
      id: 'a',
      name: 'a',
      createdAt: '2026-01-01T00:00:00.000Z',
      model: 'claude-opus-4.7',
    };
    writeAgentJson(root, body);
    const before = readFileSync(new AgentHome(root).metadataPath, 'utf-8');

    // Seed asks for fields that on-disk already has.
    initWorkspaceSync(root, { model: 'claude-opus-4.7' });

    const after = readFileSync(new AgentHome(root).metadataPath, 'utf-8');
    expect(after).toBe(before);
  });

  it('does NOT rewrite when seed is omitted entirely', () => {
    const root = freshDir();
    writeAgentJson(root, {
      id: 'a',
      name: 'a',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    const before = readFileSync(new AgentHome(root).metadataPath, 'utf-8');

    const meta = initWorkspaceSync(root); // no seed

    expect(meta.id).toBe('a');
    const after = readFileSync(new AgentHome(root).metadataPath, 'utf-8');
    expect(after).toBe(before);
  });
});

describe('initWorkspaceSync — interaction with loadAgentConfigSync', () => {
  it('the returned metadata equals what the next loadAgentConfigSync sees', () => {
    const root = freshDir();
    writeAgentJson(root, {
      id: 'a',
      name: 'a',
      createdAt: '2026-01-01T00:00:00.000Z',
    });

    const fromInit = initWorkspaceSync(root, { skills: { extraDirs: ['/x'] } });
    const fromLoad = loadAgentConfigSync(root);

    expect(fromLoad).toEqual(fromInit);
    expect(fromInit.skills).toBeUndefined();
  });

  it('rejects malformed agent.json instead of treating it as runtime config', () => {
    const root = freshDir();
    writeFileSync(new AgentHome(root).metadataPath, '{ bad json', 'utf-8');

    expect(() => loadAgentConfigSync(root)).toThrow(/Failed to parse agent metadata/);
  });

  it('rejects unknown persisted agent.json fields', () => {
    const root = freshDir();
    writeAgentJson(root, {
      id: 'a',
      name: 'a',
      createdAt: '2026-01-01T00:00:00.000Z',
      productOnlyRuntimeState: true,
    });

    expect(() => loadAgentConfigSync(root)).toThrow(/Invalid agent metadata/);
  });

  it('validates patch writes before changing agent.json', () => {
    const root = freshDir();
    writeAgentJson(root, {
      id: 'a',
      name: 'a',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    const before = readFileSync(new AgentHome(root).metadataPath, 'utf-8');

    expect(() => {
      // Runtime-switchable fields must stay inside the SDK-owned schema.
      loadAgentConfigSync(root);
      saveAgentConfigSync(root, { reasoningEffort: 'turbo' as never });
    }).toThrow(/Invalid enum value/);

    const after = readFileSync(new AgentHome(root).metadataPath, 'utf-8');
    expect(after).toBe(before);
  });
});
