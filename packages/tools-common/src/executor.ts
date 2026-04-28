// ============================================================
// Berry Agent SDK — Default Command Executor (Node.js)
// ============================================================
//
// NodeExecutor is the default, non-sandboxed implementation.
// It uses bare child_process.exec / child_process.spawn.
// For OS-level isolation, use SandboxedExecutor from @berry-agent/safe.

import { exec, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { CommandExecutor, ExecOptions, ExecResult, SpawnOptions, ProcessHandle } from '@berry-agent/core';

export type { CommandExecutor, ExecOptions, ExecResult, SpawnOptions, ProcessHandle } from '@berry-agent/core';

/**
 * Bare Node.js executor — uses child_process directly, no sandbox.
 * This is the default when no sandbox is configured.
 */
export class NodeExecutor implements CommandExecutor {
  exec(command: string, options: ExecOptions): Promise<ExecResult> {
    return new Promise((resolve) => {
      exec(
        command,
        {
          cwd: options.cwd,
          timeout: options.timeout,
          maxBuffer: options.maxBuffer ?? 1024 * 1024,
          env: options.env ? { ...process.env, ...options.env } : undefined,
        },
        (error, stdout, stderr) => {
          let output = '';
          if (stdout) output += stdout;
          if (stderr) output += (output ? '\n' : '') + stderr;
          if (!output && error) output = error.message;

          resolve({
            output: output || '(no output)',
            isError: error ? true : false,
          });
        },
      );
    });
  }

  spawn(command: string, options: SpawnOptions): ProcessHandle {
    const child = spawn(command, {
      cwd: options.cwd,
      shell: true,
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