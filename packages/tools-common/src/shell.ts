// ============================================================
// Berry Agent SDK — Common Tools: Shell Execution
// ============================================================

import { exec } from 'node:child_process';
import type { ToolRegistration } from '@berry-agent/core';

const DEFAULT_TIMEOUT = 30_000;
const MAX_OUTPUT = 10_000;

export interface ShellToolOptions {
  /** Command timeout in ms (default: 30000) */
  timeout?: number;
  /** Max output characters (default: 10000) */
  maxOutput?: number;
  /** Blocked commands (will be denied) */
  blockedCommands?: string[];
}

/**
 * Create a shell execution tool scoped to a working directory.
 */
export function createShellTool(cwd: string, options?: ShellToolOptions): ToolRegistration {
  const timeout = options?.timeout ?? DEFAULT_TIMEOUT;
  const maxOutput = options?.maxOutput ?? MAX_OUTPUT;
  const blocked = new Set(options?.blockedCommands ?? []);

  return {
    definition: {
      name: 'shell',
      description: 'Execute a shell command and return stdout/stderr. Use for running scripts, checking status, installing packages, etc.',
      inputSchema: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Shell command to execute' },
        },
        required: ['command'],
      },
    },
    execute: async (input) => {
      const command = input.command as string;

      // Check blocked commands
      const baseCmd = command.trim().split(/\s+/)[0] ?? '';
      if (blocked.has(baseCmd)) {
        return { content: `Command "${baseCmd}" is blocked`, isError: true };
      }

      return new Promise((resolve) => {
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
    },
  };
}
