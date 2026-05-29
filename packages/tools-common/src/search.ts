// ============================================================
// Berry Agent SDK — Common Tools: Search (grep + find)
// ============================================================
//
// Search tools route through the CommandExecutor interface so
// SandboxedExecutor (from @berry-agent/safe) applies uniformly.
// Use `executor` option for parity with createShellTools().

import type { ToolRegistration, ToolContext, CommandExecutor } from '@berry-agent/core';
import { errorMessage, ToolGroup } from '@berry-agent/core';
import { NodeExecutor } from './executor.js';
import { resolveClaudeCodeRelativePath, shellEscape } from './path.js';

const MAX_OUTPUT = 10_000;
const SEARCH_TIMEOUT = 15_000;

export interface SearchToolOptions {
  /** Command executor. Defaults to NodeExecutor (no sandbox). */
  executor?: CommandExecutor;
  /** Fail closed when executor is absent. See ShellToolOptions.requireExecutor. */
  requireExecutor?: boolean;
}

/**
 * Create search tools (grep, find_files) scoped to a project directory (Claude Code style).
 *
 * Path rules:
 *   "/path"     → relative to projectRoot
 *   "path"      → relative to cwd (from ToolContext)
 *   "//abs/path" → absolute path (must stay within projectRoot)
 */
export function createSearchTools(
  projectRoot: string,
  options?: SearchToolOptions,
): ToolRegistration[] {
  if (options?.requireExecutor && !options.executor) {
    throw new Error(
      'createSearchTools: requireExecutor is set but no executor was provided. '
      + 'Refusing to fall back to the local NodeExecutor for a remote/machine Hand.',
    );
  }
  const executor = options?.executor ?? new NodeExecutor();

  const run = async (cmd: string): Promise<{ content: string; isError?: boolean }> => {
    const result = await executor.exec(cmd, {
      cwd: projectRoot,
      timeout: SEARCH_TIMEOUT,
      maxBuffer: 1024 * 1024,
    });
    let output = result.output === '(no output)' ? '' : result.output;
    if (output.length > MAX_OUTPUT) {
      output = output.slice(0, MAX_OUTPUT) + '\n... [truncated]';
    }
    return {
      content: output || '(no matches)',
      // grep exits 1 on no-match; the `|| echo` fallback in the command absorbs that,
      // so a real error flag here means a tool-level failure (bad path, killed, etc.).
      isError: result.isError && !output ? true : undefined,
    };
  };

  return [
    {
      definition: {
        name: 'grep',
        group: ToolGroup.Search,
        description: 'Search for a pattern in files using grep. Returns matching lines with file paths. ' +
          'Use "/path" for project-root-relative, "path" for cwd-relative, "//abs/path" for absolute.',
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
      execute: async (input, context: ToolContext) => {
        try {
          const cwd = context?.cwd ?? projectRoot;
          const pattern = input.pattern as string;
          const path = resolveClaudeCodeRelativePath(projectRoot, cwd, (input.path as string) || '.');
          const include = typeof input.include === 'string'
            ? `--include=${shellEscape(input.include)}`
            : '';
          return run(`grep -rn ${include} -e ${shellEscape(pattern)} ${shellEscape(path)} 2>/dev/null || echo '(no matches)'`);
        } catch (err) {
          return { content: `Error: ${errorMessage(err)}`, isError: true };
        }
      },
    },
    {
      definition: {
        name: 'find_files',
        group: ToolGroup.Search,
        description: 'Find files by name pattern. Returns matching file paths. ' +
          'Use "/path" for project-root-relative, "path" for cwd-relative, "//abs/path" for absolute.',
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
      execute: async (input, context: ToolContext) => {
        try {
          const cwd = context?.cwd ?? projectRoot;
          const pattern = input.pattern as string;
          const path = resolveClaudeCodeRelativePath(projectRoot, cwd, (input.path as string) || '.');
          const maxDepth = typeof input.maxDepth === 'number' && Number.isFinite(input.maxDepth)
            ? Math.max(0, Math.trunc(input.maxDepth))
            : undefined;
          const depth = maxDepth !== undefined ? `-maxdepth ${maxDepth}` : '';
          return run(`find ${shellEscape(path)} ${depth} -name ${shellEscape(pattern)} -not -path '*/node_modules/*' -not -path '*/.git/*' 2>/dev/null | head -100`);
        } catch (err) {
          return { content: `Error: ${errorMessage(err)}`, isError: true };
        }
      },
    },
  ];
}
