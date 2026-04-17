// ============================================================
// Berry Agent SDK — Common Tools: Search (grep + find)
// ============================================================

import { exec } from 'node:child_process';
import type { ToolRegistration } from '@berry-agent/core';
import { resolveScopedRelativePath, shellEscape } from './path.js';

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
        try {
          const pattern = input.pattern as string;
          const path = resolveScopedRelativePath(baseDir, (input.path as string) || '.');
          const include = typeof input.include === 'string'
            ? `--include=${shellEscape(input.include)}`
            : '';
          return run(`grep -rn ${include} -e ${shellEscape(pattern)} ${shellEscape(path)} 2>/dev/null || echo '(no matches)'`);
        } catch (err) {
          return { content: `Error: ${err instanceof Error ? err.message : String(err)}`, isError: true };
        }
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
        try {
          const pattern = input.pattern as string;
          const path = resolveScopedRelativePath(baseDir, (input.path as string) || '.');
          const maxDepth = typeof input.maxDepth === 'number' && Number.isFinite(input.maxDepth)
            ? Math.max(0, Math.trunc(input.maxDepth))
            : undefined;
          const depth = maxDepth !== undefined ? `-maxdepth ${maxDepth}` : '';
          return run(`find ${shellEscape(path)} ${depth} -name ${shellEscape(pattern)} -not -path '*/node_modules/*' -not -path '*/.git/*' 2>/dev/null | head -100`);
        } catch (err) {
          return { content: `Error: ${err instanceof Error ? err.message : String(err)}`, isError: true };
        }
      },
    },
  ];
}
