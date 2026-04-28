// ============================================================
// Berry Agent SDK — Command Executor Interface
// ============================================================
//
// This interface lives in @berry-agent/core so that both
// @berry-agent/tools-common (NodeExecutor) and @berry-agent/safe
// (SandboxedExecutor) can implement it without circular dependency.
//
// Dependency direction:
//   core              → defines CommandExecutor
//   tools-common      → implements NodeExecutor (default, no sandbox)
//   safe              → implements SandboxedExecutor (Seatbelt / bubblewrap)
//   berry-claw        → picks which executor to inject

// ===== Types =====

export interface ExecOptions {
  /** Working directory for the command. */
  cwd: string;
  /** Timeout in milliseconds. */
  timeout?: number;
  /** Max buffer size in bytes. Default 1MB. */
  maxBuffer?: number;
  /** Environment variables (merged with process.env if partial). */
  env?: Record<string, string | undefined>;
}

export interface ExecResult {
  /** Combined stdout + stderr output. */
  output: string;
  /** Whether the command errored (non-zero exit, timeout, etc.). */
  isError: boolean;
}

export interface SpawnOptions {
  /** Working directory for the command. */
  cwd: string;
  /** Environment variables. */
  env?: Record<string, string | undefined>;
}

export interface ProcessHandle {
  /** Process ID (if available). */
  pid: number | undefined;
  /** Write to stdin. */
  write(data: string): Promise<void>;
  /** Send signal (default SIGTERM). */
  kill(signal?: string): void;
  /** Register stdout data handler. */
  onStdOut(handler: (chunk: string) => void): void;
  /** Register stderr data handler. */
  onStdErr(handler: (chunk: string) => void): void;
  /** Register error handler. */
  onError(handler: (error: Error) => void): void;
  /** Register exit handler. */
  onExit(handler: (code: number | null, signal: string | null) => void): void;
  /** Whether stdin is still writable. */
  readonly stdinWritable: boolean;
}

// ===== Interface =====

/**
 * Abstraction over command execution.
 *
 * Tools call `executor.exec(command, opts)` and `executor.spawn(command, opts)`
 * without knowing whether the command runs bare or inside a sandbox.
 */
export interface CommandExecutor {
  /**
   * Execute a command in the foreground, capture output.
   * Equivalent to `child_process.exec()` but sandboxable.
   */
  exec(command: string, options: ExecOptions): Promise<ExecResult>;

  /**
   * Start a command in the background, return a handle for streaming I/O.
   * Equivalent to `child_process.spawn()` but sandboxable.
   */
  spawn(command: string, options: SpawnOptions): ProcessHandle;
}