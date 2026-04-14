// ============================================================
// Berry Agent SDK — Common Tools: Search (grep + find)
// ============================================================

import { exec } from 'node:child_process';
import type { ToolRegistration } from '@berry-agent/core';

const MAX_OUTPUT = 10_000;

/**
 * Create search tools (grep, find_files) scoped to a base directory.
 */
export function createSearchTools(baseDir: string): ToolRegistration[] {
  const run = (cmd: string): Promise<{ content: string; isError?: boolean }> =>
    new Promise((resolve) => {
      exec(cmd, { cwd: baseDir, timeout: 15_000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
        let output = stdout || '';
        if (stderr) output += (output ? '\n' : '') + stderr;
        if (!output && error) output = error.message;
        if (output.length > MAX_OUTPUT) output = output.slice(0, MAX_OUTPUT) + '\n... [truncated]';
        resolve({ content: output || '(no matches)', isError: error && !stdout ? true : undefined });
      });
    });

  return [
    {
      definition: {
        name: 'grep',
        description: 'Search for a pattern in files using grep. Returns matching lines with file paths.',
        inputSchema: {
          type: 'object',
          properties: {
            pattern: { type: 'string', description: 'Search pattern (regex supported)' },
            path: { type: 'string', description: 'Directory or file to search in (default: ".")' },
            include: { type: 'string', description: 'File glob pattern (e.g. "*.ts")' },
          },
          required: ['pattern'],
        },
      },
      execute: async (input) => {
        const pattern = (input.pattern as string).replace(/'/g, "'\\''");
        const path = (input.path as string) || '.';
        const include = input.include ? `--include='${input.include}'` : '';
        return run(`grep -rn ${include} '${pattern}' ${path} 2>/dev/null || echo '(no matches)'`);
      },
    },
    {
      definition: {
        name: 'find_files',
        description: 'Find files by name pattern. Returns matching file paths.',
        inputSchema: {
          type: 'object',
          properties: {
            pattern: { type: 'string', description: 'File name pattern (glob, e.g. "*.ts")' },
            path: { type: 'string', description: 'Directory to search in (default: ".")' },
            maxDepth: { type: 'number', description: 'Maximum directory depth' },
          },
          required: ['pattern'],
        },
      },
      execute: async (input) => {
        const pattern = (input.pattern as string).replace(/'/g, "'\\''");
        const path = (input.path as string) || '.';
        const depth = input.maxDepth ? `-maxdepth ${input.maxDepth}` : '';
        return run(`find ${path} ${depth} -name '${pattern}' -not -path '*/node_modules/*' -not -path '*/.git/*' 2>/dev/null | head -100`);
      },
    },
  ];
}
