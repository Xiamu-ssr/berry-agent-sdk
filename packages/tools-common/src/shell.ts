// ============================================================
// Berry Agent SDK — Common Tools: Shell Execution
// ============================================================

import { exec, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { ToolRegistration } from '@berry-agent/core';
import {
  TOOL_PROCESS_KILL,
  TOOL_PROCESS_LIST,
  TOOL_PROCESS_LOG,
  TOOL_PROCESS_POLL,
  TOOL_PROCESS_WRITE,
  TOOL_SHELL,
} from '@berry-agent/core';

const DEFAULT_TIMEOUT = 30_000;
const MAX_OUTPUT = 10_000;
const TRUNCATED_PREFIX = '[truncated earlier output]\n';

export interface ShellToolOptions {
  /** Command timeout in ms (default: 30000) */
  timeout?: number;
  /** Max output characters (default: 10000) */
  maxOutput?: number;
  /** Blocked commands (will be denied) */
  blockedCommands?: string[];
}

type ProcessStatus = 'running' | 'exited';

interface ProcessSession {
  id: string;
  command: string;
  cwd: string;
  child: ChildProcessWithoutNullStreams;
  startedAt: number;
  endedAt?: number;
  pid: number | undefined;
  status: ProcessStatus;
  exitCode: number | null;
  signal: string | null;
  log: string;
  truncated: boolean;
}

interface ProcessSummary {
  id: string;
  command: string;
  cwd: string;
  pid: number | null;
  status: ProcessStatus;
  startedAt: number;
  endedAt?: number;
  exitCode: number | null;
  signal: string | null;
}

/**
 * Create shell tools scoped to a working directory.
 * Includes the foreground/background shell tool plus first-stage process tools.
 */
export function createShellTools(cwd: string, options?: ShellToolOptions): ToolRegistration[] {
  const timeout = options?.timeout ?? DEFAULT_TIMEOUT;
  const maxOutput = options?.maxOutput ?? MAX_OUTPUT;
  const blocked = new Set(options?.blockedCommands ?? []);
  const manager = new ProcessSessionManager(cwd, maxOutput);

  const ensureAllowedCommand = (command: string): string | null => {
    const baseCmd = command.trim().split(/\s+/)[0] ?? '';
    if (blocked.has(baseCmd)) {
      return `Command "${baseCmd}" is blocked`;
    }
    return null;
  };

  const runForeground = async (command: string) => new Promise<{ content: string; isError?: boolean }>((resolve) => {
    exec(command, { cwd, timeout, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      let output = '';
      if (stdout) output += stdout;
      if (stderr) output += (output ? '\n' : '') + stderr;
      if (!output && error) output = error.message;

      if (output.length > maxOutput) {
        output = output.slice(0, maxOutput) + `\n... [truncated, ${output.length} total chars]`;
      }

      resolve({
        content: output || '(no output)',
        isError: error ? true : undefined,
      });
    });
  });

  return [
    {
      definition: {
        name: TOOL_SHELL,
        description: 'Execute a shell command. Set background=true to start a first-stage managed process session.',
        inputSchema: {
          type: 'object',
          properties: {
            command: { type: 'string', description: 'Shell command to execute' },
            background: { type: 'boolean', description: 'Run command in the background and return a session ID' },
          },
          required: ['command'],
        },
      },
      execute: async (input) => {
        const command = input.command as string;
        const blockedMessage = ensureAllowedCommand(command);
        if (blockedMessage) {
          return { content: blockedMessage, isError: true };
        }

        if (input.background === true) {
          const session = manager.start(command);
          return {
            content: JSON.stringify({
              sessionId: session.id,
              status: session.status,
              pid: session.pid,
              command: session.command,
            }, null, 2),
          };
        }

        return runForeground(command);
      },
    },
    {
      definition: {
        name: TOOL_PROCESS_LIST,
        description: 'List tracked background shell processes created by shell({ background: true }).',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      execute: async () => ({
        content: JSON.stringify({ processes: manager.list() }, null, 2),
      }),
    },
    {
      definition: {
        name: TOOL_PROCESS_POLL,
        description: 'Poll the latest status for a tracked background process.',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Process session ID returned by shell({ background: true })' },
          },
          required: ['id'],
        },
      },
      execute: async (input) => {
        const session = manager.poll(input.id as string);
        if (!session) {
          return { content: `Process not found: ${String(input.id)}`, isError: true };
        }

        return {
          content: JSON.stringify(session, null, 2),
        };
      },
    },
    {
      definition: {
        name: TOOL_PROCESS_LOG,
        description: 'Read captured stdout/stderr for a tracked background process.',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Process session ID returned by shell({ background: true })' },
          },
          required: ['id'],
        },
      },
      execute: async (input) => {
        const output = manager.log(input.id as string);
        if (output === null) {
          return { content: `Process not found: ${String(input.id)}`, isError: true };
        }

        return { content: output || '(no output)' };
      },
    },
    {
      definition: {
        name: TOOL_PROCESS_WRITE,
        description: 'Write data to stdin for a tracked background process.',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Process session ID returned by shell({ background: true })' },
            data: { type: 'string', description: 'Data to write to the process stdin' },
          },
          required: ['id', 'data'],
        },
      },
      execute: async (input) => {
        try {
          const result = await manager.write(input.id as string, input.data as string);
          return {
            content: JSON.stringify(result, null, 2),
          };
        } catch (err) {
          return { content: `Error: ${err instanceof Error ? err.message : String(err)}`, isError: true };
        }
      },
    },
    {
      definition: {
        name: TOOL_PROCESS_KILL,
        description: 'Stop a tracked background process with SIGTERM.',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Process session ID returned by shell({ background: true })' },
          },
          required: ['id'],
        },
      },
      execute: async (input) => {
        try {
          const result = manager.kill(input.id as string);
          return {
            content: JSON.stringify(result, null, 2),
          };
        } catch (err) {
          return { content: `Error: ${err instanceof Error ? err.message : String(err)}`, isError: true };
        }
      },
    },
  ];
}

/**
 * Backward-compatible single shell tool factory.
 * Use createShellTools() or createAllTools() when background process tools are needed.
 */
export function createShellTool(cwd: string, options?: ShellToolOptions): ToolRegistration {
  return createShellTools(cwd, options)[0];
}

class ProcessSessionManager {
  private readonly sessions = new Map<string, ProcessSession>();

  constructor(
    private readonly cwd: string,
    private readonly maxOutput: number,
  ) {}

  start(command: string): ProcessSummary {
    const child = spawn(command, {
      cwd: this.cwd,
      shell: true,
      stdio: 'pipe',
    });

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

    const session: ProcessSession = {
      id: `proc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      command,
      cwd: this.cwd,
      child,
      startedAt: Date.now(),
      pid: child.pid,
      status: 'running',
      exitCode: null,
      signal: null,
      log: '',
      truncated: false,
    };

    child.stdout.on('data', (chunk: string) => {
      this.appendLog(session, chunk);
    });

    child.stderr.on('data', (chunk: string) => {
      this.appendLog(session, chunk);
    });

    child.on('error', (error) => {
      this.appendLog(session, `Process error: ${error.message}\n`);
      session.status = 'exited';
      session.exitCode = session.exitCode ?? 1;
      session.endedAt = Date.now();
    });

    child.on('exit', (code, signal) => {
      session.status = 'exited';
      session.exitCode = code;
      session.signal = signal;
      session.endedAt = Date.now();
    });

    this.sessions.set(session.id, session);
    return this.toSummary(session);
  }

  list(): ProcessSummary[] {
    return [...this.sessions.values()]
      .map((session) => this.toSummary(session))
      .sort((a, b) => b.startedAt - a.startedAt);
  }

  poll(id: string): ProcessSummary | null {
    const session = this.sessions.get(id);
    return session ? this.toSummary(session) : null;
  }

  log(id: string): string | null {
    const session = this.sessions.get(id);
    return session ? session.log : null;
  }

  async write(id: string, data: string): Promise<ProcessSummary & { bytesWritten: number }> {
    const session = this.sessions.get(id);
    if (!session) {
      throw new Error(`Process not found: ${id}`);
    }
    if (session.status !== 'running') {
      throw new Error(`Process is not running: ${id}`);
    }
    if (!session.child.stdin.writable) {
      throw new Error(`Process stdin is not writable: ${id}`);
    }

    await new Promise<void>((resolve, reject) => {
      session.child.stdin.write(data, (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });

    return {
      ...this.toSummary(session),
      bytesWritten: data.length,
    };
  }

  kill(id: string): ProcessSummary {
    const session = this.sessions.get(id);
    if (!session) {
      throw new Error(`Process not found: ${id}`);
    }
    if (session.status === 'running') {
      session.child.kill('SIGTERM');
    }
    return this.toSummary(session);
  }

  private toSummary(session: ProcessSession): ProcessSummary {
    return {
      id: session.id,
      command: session.command,
      cwd: session.cwd,
      pid: session.pid ?? null,
      status: session.status,
      startedAt: session.startedAt,
      endedAt: session.endedAt,
      exitCode: session.exitCode,
      signal: session.signal,
    };
  }

  private appendLog(session: ProcessSession, chunk: string): void {
    const existing = session.truncated && session.log.startsWith(TRUNCATED_PREFIX)
      ? session.log.slice(TRUNCATED_PREFIX.length)
      : session.log;
    const combined = existing + chunk;
    if (combined.length <= this.maxOutput) {
      session.log = combined;
      return;
    }

    session.truncated = true;
    session.log = `${TRUNCATED_PREFIX}${combined.slice(-this.maxOutput)}`;
  }
}
