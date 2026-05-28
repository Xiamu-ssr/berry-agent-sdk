// ============================================================
// Berry Agent SDK — Child Process → ProcessHandle Adapter
// ============================================================
//
// Both NodeExecutor (@berry-agent/tools-common) and SeatbeltExecutor
// (@berry-agent/safe) wrap a ChildProcessWithoutNullStreams as a
// CommandExecutor `ProcessHandle`. Keep the adapter logic in one place
// so the two implementations stay byte-identical.

import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { ExecResult, ProcessHandle } from './executor.js';

/**
 * Wrap a Node `ChildProcessWithoutNullStreams` as a CommandExecutor `ProcessHandle`.
 * Caller must ensure the child was spawned with `stdio: 'pipe'` (or compatible)
 * and stream encodings set to 'utf8' for chunk handlers to receive strings.
 */
export function processHandleFromChild(child: ChildProcessWithoutNullStreams): ProcessHandle {
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

/**
 * Compose an `ExecResult` from captured stdout/stderr and an optional error.
 * Mirrors the historical "(no output)" fallback used by both executors.
 */
export function composeExecResult(
  stdout: string,
  stderr: string,
  error: Error | null,
  isError: boolean,
): ExecResult {
  let output = '';
  if (stdout) output += stdout;
  if (stderr) output += (output ? '\n' : '') + stderr;
  if (!output && error) output = error.message;
  return {
    output: output || '(no output)',
    isError,
  };
}
