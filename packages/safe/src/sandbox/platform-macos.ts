// ============================================================
// Berry Agent SDK — Sandboxed Executor (macOS Seatbelt)
// ============================================================
//
// Implements CommandExecutor using macOS `sandbox-exec`.
// Commands run inside a Seatbelt sandbox with the policy derived
// from SandboxConfig. The tool code calling executor.exec() has
// zero awareness of this — it just gets back stdout/stderr and
// exit codes. "Permission denied" errors from OS-level denials
// look identical to regular file-permission errors.

import { exec, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { CommandExecutor, ExecOptions, ExecResult, SpawnOptions, ProcessHandle } from '@berry-agent/core';
import type { SandboxConfig } from './types.js';
import { buildSeatbeltProfile } from './profile-builder.js';

/**
 * Create a sandboxed CommandExecutor for macOS using Seatbelt.
 *
 * Usage:
 *   import { createSandboxedExecutor } from '@berry-agent/safe';
 *   const executor = createSandboxedExecutor({
 *     allowRead: [projectRoot, '/usr', '/tmp'],
 *     allowWrite: [projectRoot],
 *     network: 'deny',
 *   });
 *   // Pass to shell tools — they won't know they're sandboxed
 *   const tools = createShellTools(projectRoot, { executor });
 */
export function createSandboxedExecutor(config: SandboxConfig): CommandExecutor {
  const profile = buildSeatbeltProfile(config);
  return new SeatbeltExecutor(profile);
}

/**
 * macOS Seatbelt implementation of CommandExecutor.
 * Wraps every command in `sandbox-exec -p <profile> -- <command>`.
 */
class SeatbeltExecutor implements CommandExecutor {
  constructor(private readonly profile: string) {}

  exec(command: string, options: ExecOptions): Promise<ExecResult> {
    const args = ['-p', this.profile, '--', '/bin/bash', '-c', command];

    return new Promise((resolve) => {
      const child = spawn('/usr/bin/sandbox-exec', args, {
        cwd: options.cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: options.env ? { ...process.env, ...options.env } : process.env,
      });

      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => { stdout += chunk; });
      child.stderr.on('data', (chunk: string) => { stderr += chunk; });

      const timeout = options.timeout;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let settled = false;

      const finish = (error: Error | null, code: number | null) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);

        let output = '';
        if (stdout) output += stdout;
        if (stderr) output += (output ? '\n' : '') + stderr;
        if (!output && error) output = error.message;

        resolve({
          output: output || '(no output)',
          isError: error ? true : (code !== 0 && code !== null),
        });
      };

      if (timeout) {
        timer = setTimeout(() => {
          child.kill('SIGKILL');
          finish(new Error(`Command timed out after ${timeout}ms`), null);
        }, timeout);
      }

      child.on('error', (err) => finish(err, null));
      child.on('exit', (code) => finish(null, code));
    });
  }

  spawn(command: string, options: SpawnOptions): ProcessHandle {
    const args = ['-p', this.profile, '--', '/bin/bash', '-c', command];

    const child = spawn('/usr/bin/sandbox-exec', args, {
      cwd: options.cwd,
      stdio: 'pipe',
      env: options.env ? { ...process.env, ...options.env } : process.env,
    }) as ChildProcessWithoutNullStreams;

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

    return {
      pid: child.pid,
      get stdinWritable() {
        return child.stdin.writable;
      },
      write: (data: string) =>
        new Promise<void>((resolve, reject) => {
          child.stdin.write(data, (error) => {
            if (error) reject(error);
            else resolve();
          });
        }),
      kill: (signal?: string) => {
        child.kill((signal ?? 'SIGTERM') as NodeJS.Signals);
      },
      onStdOut: (handler) => child.stdout.on('data', handler),
      onStdErr: (handler) => child.stderr.on('data', handler),
      onError: (handler) => child.on('error', handler),
      onExit: (handler) => child.on('exit', (code, signal) => handler(code, signal)),
    };
  }
}