import { describe, it, expect } from 'vitest';
import { resolveClaudeCodePath, resolveClaudeCodeRelativePath, resolveScopedPath } from '../path.js';
import { resolve } from 'node:path';

describe('resolveClaudeCodePath', () => {
  const projectRoot = '/Users/test/project';
  const cwd = '/Users/test/project/src';

  it('resolves "/path" relative to projectRoot', () => {
    const result = resolveClaudeCodePath(projectRoot, cwd, '/README.md');
    expect(result).toBe(resolve(projectRoot, 'README.md'));
  });

  it('resolves "path" relative to cwd', () => {
    const result = resolveClaudeCodePath(projectRoot, cwd, 'utils/helper.ts');
    expect(result).toBe(resolve(cwd, 'utils/helper.ts'));
  });

  it('resolves "//abs/path" as absolute path', () => {
    // // prefix is the CC convention for "this is an absolute path"
    // "//Users/test/project/deep/file.ts" → "/Users/test/project/deep/file.ts"
    const result = resolveClaudeCodePath(projectRoot, cwd, `//${projectRoot}/deep/file.ts`);
    expect(result).toBe(resolve(`${projectRoot}/deep/file.ts`));
  });

  it('resolves "/" as projectRoot itself', () => {
    const result = resolveClaudeCodePath(projectRoot, cwd, '/');
    expect(result).toBe(resolve(projectRoot));
  });

  it('resolves "." as cwd', () => {
    const result = resolveClaudeCodePath(projectRoot, cwd, '.');
    expect(result).toBe(resolve(cwd));
  });

  it('throws on path escaping projectRoot via ../', () => {
    expect(() => resolveClaudeCodePath(projectRoot, cwd, '../../etc/passwd'))
      .toThrow('Path escapes project directory');
  });

  it('throws on absolute path outside projectRoot', () => {
    expect(() => resolveClaudeCodePath(projectRoot, cwd, '//etc/passwd'))
      .toThrow('Path escapes project directory');
  });

  it('allows cwd-relative path that stays within projectRoot', () => {
    // cwd = projectRoot/src, "../README.md" resolves to projectRoot/README.md — valid
    const result = resolveClaudeCodePath(projectRoot, cwd, '../README.md');
    expect(result).toBe(resolve(projectRoot, 'README.md'));
  });

  it('throws on cwd-relative path that escapes projectRoot', () => {
    // cwd = projectRoot/src, "../../outside" resolves to outside project — blocked
    expect(() => resolveClaudeCodePath(projectRoot, cwd, '../../outside'))
      .toThrow('Path escapes project directory');
  });

  it('when cwd === projectRoot, "path" and "/path" are equivalent', () => {
    const r1 = resolveClaudeCodePath(projectRoot, projectRoot, 'foo.txt');
    const r2 = resolveClaudeCodePath(projectRoot, projectRoot, '/foo.txt');
    expect(r1).toBe(r2);
  });
});

describe('resolveClaudeCodeRelativePath', () => {
  const projectRoot = '/Users/test/project';
  const cwd = '/Users/test/project/src';

  it('returns path relative to projectRoot for project-root-relative input', () => {
    const result = resolveClaudeCodeRelativePath(projectRoot, cwd, '/README.md');
    expect(result).toBe('README.md');
  });

  it('returns path relative to projectRoot for cwd-relative input', () => {
    const result = resolveClaudeCodeRelativePath(projectRoot, cwd, 'utils/helper.ts');
    expect(result).toBe('src/utils/helper.ts');
  });

  it('returns "." for projectRoot itself', () => {
    const result = resolveClaudeCodeRelativePath(projectRoot, cwd, '/');
    expect(result).toBe('.');
  });
});

describe('resolveScopedPath (legacy)', () => {
  const baseDir = '/Users/test/project';

  it('resolves relative path within baseDir', () => {
    const result = resolveScopedPath(baseDir, 'src/index.ts');
    expect(result).toBe(resolve(baseDir, 'src/index.ts'));
  });

  it('resolves "." as baseDir', () => {
    const result = resolveScopedPath(baseDir, '.');
    expect(result).toBe(resolve(baseDir));
  });

  it('throws on path escaping baseDir', () => {
    expect(() => resolveScopedPath(baseDir, '../../etc/passwd'))
      .toThrow('Path escapes base directory');
  });
});