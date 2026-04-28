import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AgentScope } from '../scope.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync, realpathSync } from 'node:fs';

describe('AgentScope', () => {
  const tmps: string[] = [];

  function makeTmp(): string {
    const d = mkdtempSync(join(tmpdir(), 'scope-test-'));
    tmps.push(d);
    return realpathSync(d);
  }

  afterEach(() => {
    for (const d of tmps) {
      try { rmSync(d, { recursive: true }); } catch { /* best-effort */ }
    }
    tmps.length = 0;
  });

  describe('constructor', () => {
    it('resolves workspace path', () => {
      const ws = makeTmp();
      const scope = new AgentScope(ws);
      expect(scope.workspace).toBe(ws);
    });

    it('sets project when provided', () => {
      const ws = makeTmp();
      const proj = makeTmp();
      const scope = new AgentScope(ws, proj);
      expect(scope.project).toBe(proj);
    });

    it('project is null by default', () => {
      const ws = makeTmp();
      const scope = new AgentScope(ws);
      expect(scope.project).toBeNull();
    });
  });

  describe('fromRoot', () => {
    it('sets both workspace and project to the same root', () => {
      const root = makeTmp();
      const scope = AgentScope.fromRoot(root);
      expect(scope.workspace).toBe(root);
      expect(scope.project).toBe(root);
    });
  });

  describe('projectDir', () => {
    it('returns project when set', () => {
      const ws = makeTmp();
      const proj = makeTmp();
      const scope = new AgentScope(ws, proj);
      expect(scope.projectDir).toBe(proj);
    });

    it('falls back to workspace when no project', () => {
      const ws = makeTmp();
      const scope = new AgentScope(ws);
      expect(scope.projectDir).toBe(ws);
    });
  });

  describe('writableRoots', () => {
    it('includes both project and workspace when project is set', () => {
      const ws = makeTmp();
      const proj = makeTmp();
      const scope = new AgentScope(ws, proj);
      expect(scope.writableRoots).toEqual([proj, ws]);
    });

    it('includes only workspace when no project', () => {
      const ws = makeTmp();
      const scope = new AgentScope(ws);
      expect(scope.writableRoots).toEqual([ws]);
    });
  });

  describe('isWritable', () => {
    it('allows writing to project directory', () => {
      const ws = makeTmp();
      const proj = makeTmp();
      const scope = new AgentScope(ws, proj);
      expect(scope.isWritable(join(proj, 'src', 'file.ts'))).toBe(true);
    });

    it('allows writing to workspace directory', () => {
      const ws = makeTmp();
      const proj = makeTmp();
      const scope = new AgentScope(ws, proj);
      expect(scope.isWritable(join(ws, 'MEMORY.md'))).toBe(true);
    });

    it('denies writing outside all roots', () => {
      const ws = makeTmp();
      const scope = new AgentScope(ws);
      expect(scope.isWritable('/etc/hosts')).toBe(false);
    });

    it('handles relative path escapes', () => {
      const ws = makeTmp();
      const proj = makeTmp();
      const scope = new AgentScope(ws, proj);
      expect(scope.isWritable(join(proj, '..', '..', 'etc', 'passwd'))).toBe(false);
    });

    it('allows writing to exact root', () => {
      const ws = makeTmp();
      const scope = new AgentScope(ws);
      expect(scope.isWritable(ws)).toBe(true);
    });
  });

  describe('isReadable', () => {
    it('always returns true', () => {
      const ws = makeTmp();
      const scope = new AgentScope(ws);
      expect(scope.isReadable('/etc/shadow')).toBe(true);
      expect(scope.isReadable('/anything')).toBe(true);
    });
  });

  describe('toSandboxConfig', () => {
    it('includes writableRoots + /tmp in allowWrite', () => {
      const ws = makeTmp();
      const proj = makeTmp();
      const scope = new AgentScope(ws, proj);
      const config = scope.toSandboxConfig();
      expect(config.allowRead).toEqual(['/']);
      expect(config.allowWrite).toContain(proj);
      expect(config.allowWrite).toContain(ws);
      expect(config.allowWrite).toContain('/tmp');
      expect(config.network).toBe('allow');
      expect(config.allowExec).toBe(true);
    });

    it('workspace-only scope still includes /tmp', () => {
      const ws = makeTmp();
      const scope = new AgentScope(ws);
      const config = scope.toSandboxConfig();
      expect(config.allowWrite).toEqual([ws, '/tmp']);
    });
  });
});