import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectSharedPaths } from '@berry-agent/core';
import {
  asSafetyLevel,
  projectSafetyPath,
  readProjectSafety,
  resolveSafetyLevel,
  writeProjectSafety,
} from '../project-safety.js';

let project: string;

beforeEach(async () => {
  project = await mkdtemp(join(tmpdir(), 'berry-safe-project-'));
});

afterEach(async () => {
  await rm(project, { recursive: true, force: true });
});

describe('project safety config', () => {
  it('uses the SDK project shared layout', () => {
    expect(projectSafetyPath(project)).toBe(projectSharedPaths(project).safetyPath);
  });

  it('roundtrips project safety and clears only the level field', async () => {
    writeProjectSafety(project, 'auto');
    expect(readProjectSafety(project)).toEqual({ level: 'auto' });

    const path = projectSafetyPath(project);
    await writeFile(path, JSON.stringify({ level: 'trust', note: 'keep' }, null, 2), 'utf-8');
    writeProjectSafety(project, null);

    const raw = JSON.parse(await readFile(path, 'utf-8')) as Record<string, unknown>;
    expect(raw).toEqual({ note: 'keep' });
  });

  it('resolves agent, project, global, then default', () => {
    writeProjectSafety(project, 'auto');
    expect(resolveSafetyLevel('trust', project, 'default')).toBe('trust');
    expect(resolveSafetyLevel(undefined, project, 'default')).toBe('auto');
    expect(resolveSafetyLevel(undefined, undefined, 'trust')).toBe('trust');
    expect(resolveSafetyLevel(undefined, undefined, undefined)).toBe('default');
  });

  it('ignores invalid values and corrupt project files', async () => {
    writeProjectSafety(project, null);
    await writeFile(projectSafetyPath(project), '{not-json', 'utf-8');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(readProjectSafety(project)).toBeNull();
      await writeFile(projectSafetyPath(project), JSON.stringify({ level: 'root' }), 'utf-8');
      expect(readProjectSafety(project)).toBeNull();
      expect(resolveSafetyLevel('bad', project, 'auto')).toBe('auto');
      expect(asSafetyLevel('bad')).toBeNull();
    } finally {
      warn.mockRestore();
    }
  });
});
