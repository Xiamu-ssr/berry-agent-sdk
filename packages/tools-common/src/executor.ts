// ============================================================
// Berry Agent SDK — Default Command Executor (Node.js)
// ============================================================
//
// NodeExecutor is the default, non-sandboxed implementation.
// It uses bare child_process.exec / child_process.spawn.
// For OS-level isolation, use SandboxedExecutor from @berry-agent/safe.

import { exec, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { composeExecResult, createCommandEnvironment, processHandleFromChild } from '@berry-agent/core';
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
          env: createCommandEnvironment({ env: options.env }),
        },
        (error, stdout, stderr) => {
          resolve(composeExecResult(stdout ?? '', stderr ?? '', error, error ? true : false));
        },
      );
    });
  }

  spawn(command: string, options: SpawnOptions): ProcessHandle {
    const child = spawn(command, {
      cwd: options.cwd,
      shell: true,
      stdio: 'pipe',
      env: createCommandEnvironment({ env: options.env }),
    }) as ChildProcessWithoutNullStreams;

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

    return processHandleFromChild(child);
  }
}
