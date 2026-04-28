// ============================================================
// Berry Agent SDK — Sandbox Tests
// ============================================================

import { describe, it, expect } from 'vitest';
import { buildSeatbeltProfile } from '../sandbox/profile-builder.js';
import { defaultSandboxConfig } from '../sandbox/default-config.js';
import { createSandbox } from '../sandbox/index.js';
import { tmpdir } from 'node:os';
import { mkdtempSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { join } from 'node:path';

describe('buildSeatbeltProfile', () => {
  it('generates a profile with deny default and global read', () => {
    const profile = buildSeatbeltProfile({
      allowRead: ['/'],
      allowWrite: ['/project'],
      network: 'deny',
    });
    expect(profile).toContain('(deny default)');
    expect(profile).toContain('(allow file-read*)');
    expect(profile).toContain('(allow file-write* (subpath "/project"))');
    expect(profile).toContain('(deny network*)');
    expect(profile).toContain('(allow process-exec)');
    expect(profile).toContain('(allow mach-lookup)');
  });

  it('allows network when configured', () => {
    const profile = buildSeatbeltProfile({
      allowRead: ['/'],
      allowWrite: ['/project'],
      network: 'allow',
    });
    expect(profile).toContain('(allow network*)');
    expect(profile).not.toContain('(deny network*)');
  });

  it('supports allowDomains network policy', () => {
    const profile = buildSeatbeltProfile({
      allowRead: ['/'],
      allowWrite: ['/project'],
      network: { allowDomains: ['api.anthropic.com', 'github.com'] },
    });
    expect(profile).toContain('(deny network*)');
    expect(profile).toContain('(allow network-outbound (literal "api.anthropic.com"))');
    expect(profile).toContain('(allow network-outbound (literal "github.com"))');
  });

  it('adds deny paths that override allow rules', () => {
    const profile = buildSeatbeltProfile({
      allowRead: ['/'],
      allowWrite: ['/project'],
      denyPaths: ['/etc/shadow', '/home/user/.ssh'],
      network: 'deny',
    });
    expect(profile).toContain('(deny file-read* (subpath "/etc/shadow"))');
    expect(profile).toContain('(deny file-write* (subpath "/etc/shadow"))');
    expect(profile).toContain('(deny file-read* (subpath "/home/user/.ssh"))');
  });

  it('omits process-exec when allowExec is false', () => {
    const profile = buildSeatbeltProfile({
      allowRead: ['/'],
      allowWrite: ['/project'],
      network: 'deny',
      allowExec: false,
    });
    expect(profile).not.toContain('(allow process-exec)');
    expect(profile).not.toContain('(allow process-fork)');
  });

  it('escapes special characters in paths', () => {
    const profile = buildSeatbeltProfile({
      allowRead: ['/'],
      allowWrite: ['/path/with "quotes"', '/path/with\\backslash'],
      network: 'deny',
    });
    expect(profile).toContain('subpath "/path/with \\"quotes\\""');
    expect(profile).toContain('subpath "/path/with\\\\backslash"');
  });

  it('includes macOS system basics', () => {
    const profile = buildSeatbeltProfile({
      allowRead: ['/'],
      allowWrite: ['/project'],
      network: 'deny',
    });
    expect(profile).toContain('(allow mach-lookup)');
    expect(profile).toContain('(allow file-read-metadata)');
    expect(profile).toContain('(allow sysctl-read)');
    expect(profile).toContain('(allow ipc-posix-sem)');
    expect(profile).toContain('(allow ipc-posix-shm)');
    expect(profile).toContain('(allow file-write-data (literal "/dev/null"))');
  });

  it('supports multiple write paths', () => {
    const profile = buildSeatbeltProfile({
      allowRead: ['/'],
      allowWrite: ['/project', '/tmp', '/var/log/myapp'],
      network: 'deny',
    });
    expect(profile).toContain('(allow file-write* (subpath "/project"))');
    expect(profile).toContain('(allow file-write* (subpath "/tmp"))');
    expect(profile).toContain('(allow file-write* (subpath "/var/log/myapp"))');
  });
});

describe('defaultSandboxConfig', () => {
  it('includes project root in write paths', () => {
    const config = defaultSandboxConfig('/my/project');
    expect(config.allowWrite).toContain('/my/project');
  });

  it('allows global read by default', () => {
    const config = defaultSandboxConfig('/my/project');
    expect(config.allowRead).toContain('/');
  });

  it('denies sensitive paths by default', () => {
    const config = defaultSandboxConfig('/my/project');
    expect(config.denyPaths).toBeDefined();
    expect(config.denyPaths!.length).toBeGreaterThan(0);
    expect(config.denyPaths).toContain('/etc/shadow');
    expect(config.denyPaths).toContain('/etc/sudoers');
  });

  it('allows network by default', () => {
    const config = defaultSandboxConfig('/my/project');
    expect(config.network).toBe('allow');
  });

  it('allows overrides', () => {
    const config = defaultSandboxConfig('/my/project', { network: 'allow' });
    expect(config.network).toBe('allow');
    // Other defaults should still be present
    expect(config.denyPaths).toBeDefined();
    expect(config.allowWrite).toContain('/my/project');
  });
});

describe('createSandbox', () => {
  it('returns an executor on macOS', () => {
    const config = defaultSandboxConfig('/tmp');
    const executor = createSandbox(config);
    if (process.platform === 'darwin') {
      expect(executor).not.toBeNull();
    } else {
      expect(executor).toBeNull();
    }
  });

  it('respects platform override', () => {
    const config = defaultSandboxConfig('/tmp', { platform: 'linux' });
    // Linux not implemented yet, should return null
    const executor = createSandbox(config);
    expect(executor).toBeNull();
  });
});

// Integration tests — only run on macOS where Seatbelt is available
describe.skipIf(process.platform !== 'darwin')('Seatbelt integration', () => {
  it('executes a command inside the sandbox', async () => {
    const executor = createSandbox(defaultSandboxConfig('/tmp'));
    const result = await executor!.exec('echo "hello from sandbox"', {
      cwd: '/tmp',
      timeout: 5000,
    });
    expect(result.isError).toBe(false);
    expect(result.output).toContain('hello from sandbox');
  });

  it('allows network access by default', async () => {
    const executor = createSandbox(defaultSandboxConfig('/tmp'));
    const result = await executor!.exec('curl -s --connect-timeout 3 -o /dev/null -w "%{http_code}" http://example.com', {
      cwd: '/tmp',
      timeout: 10000,
    });
    // Should get a 200 or 3xx redirect — network is allowed
    expect(result.output).toMatch(/200|301|302/);
  });

  it('denies network when network=deny override', async () => {
    const executor = createSandbox(defaultSandboxConfig('/tmp', { network: 'deny' }));
    const result = await executor!.exec('curl -s --connect-timeout 1 http://example.com 2>&1; echo "EXIT:$?"', {
      cwd: '/tmp',
      timeout: 10000,
    });
    // curl should fail — network denied
    expect(result.output).not.toContain('example');
  });

  it('denies writing to disallowed paths', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'sandbox-test-'));
    const resolvedDir = realpathSync(workDir);
    try {
      // allowWrite only includes resolvedDir, not /var
      const executor = createSandbox(defaultSandboxConfig(resolvedDir));
      const result = await executor!.exec(`touch /var/sandbox-test-write-${Date.now()} 2>&1`, {
        cwd: resolvedDir,
        timeout: 5000,
      });
      expect(result.output.toLowerCase()).toMatch(/permission denied|operation not permitted|denied|read-only/);
    } finally {
      // Cleanup (not sandboxed)
    }
  });

  it('allows writing to allowed paths', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'sandbox-test-'));
    // Resolve symlinks — macOS /tmp → /private/tmp, /var/folders → /private/var/folders
    const resolvedDir = realpathSync(workDir);
    try {
      const executor = createSandbox(defaultSandboxConfig(resolvedDir));
      const testFile = join(resolvedDir, 'test-write.txt');
      const result = await executor!.exec(`echo "sandbox works" > "${testFile}"`, {
        cwd: resolvedDir,
        timeout: 5000,
      });
      expect(result.isError).toBe(false);

      const readResult = await executor!.exec(`cat "${testFile}"`, {
        cwd: resolvedDir,
        timeout: 5000,
      });
      expect(readResult.output).toContain('sandbox works');
    } finally {
      // Cleanup
    }
  });

  it('spawn returns a process handle with streaming output', async () => {
    const executor = createSandbox(defaultSandboxConfig('/tmp'));
    const handle = executor!.spawn('echo "stream test" && sleep 0.1', { cwd: '/tmp' });

    let output = '';
    handle.onStdOut((chunk) => { output += chunk; });

    await new Promise<void>((resolve) => {
      handle.onExit(() => resolve());
    });

    expect(output).toContain('stream test');
  });
});