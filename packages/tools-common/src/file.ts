// ============================================================
// Berry Agent SDK — Common Tools: File Operations
// ============================================================

import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { ToolRegistration, ToolContext } from '@berry-agent/core';
import { ToolGroup } from '@berry-agent/core';
import { resolveClaudeCodePath } from './path.js';

/**
 * Create file operation tools scoped to a project directory (Claude Code style).
 * Tools: read_file, write_file, list_files
 *
 * Path rules:
 *   "/path"     → relative to projectRoot
 *   "path"      → relative to cwd (from ToolContext)
 *   "//abs/path" → absolute path (must stay within projectRoot)
 */
export function createFileTools(projectRoot: string): ToolRegistration[] {
  return [
    {
      definition: {
        name: 'read_file',
        group: ToolGroup.File,
        description: 'Read the contents of a file. Returns the file content as text. ' +
          'Use "/path" for project-root-relative, "path" for cwd-relative, "//abs/path" for absolute.',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Path to the file (Claude Code style: "/" = project root, no "/" = cwd-relative, "//" = absolute)' },
            offset: { type: 'number', description: 'Line number to start reading from (1-indexed)' },
            limit: { type: 'number', description: 'Maximum number of lines to read' },
          },
          required: ['path'],
        },
      },
      execute: async (input, context: ToolContext) => {
        try {
          const cwd = context?.cwd ?? projectRoot;
          const filePath = resolveClaudeCodePath(projectRoot, cwd, input.path as string);
          const fileContent = await readFile(filePath, 'utf-8');
          const lines = fileContent.split('\n');
          const offset = ((input.offset as number) ?? 1) - 1;
          const limit = (input.limit as number) ?? lines.length;
          const slice = lines.slice(offset, offset + limit).join('\n');
          const totalLines = lines.length;
          const showing = `[Lines ${offset + 1}-${Math.min(offset + limit, totalLines)} of ${totalLines}]`;
          return { content: limit < totalLines ? `${showing}\n${slice}` : slice };
        } catch (err) {
          return { content: `Error: ${err instanceof Error ? err.message : String(err)}`, isError: true };
        }
      },
    },
    {
      definition: {
        name: 'write_file',
        group: ToolGroup.File,
        description: 'Write content to a file. Creates parent directories if needed. ' +
          'Use "/path" for project-root-relative, "path" for cwd-relative, "//abs/path" for absolute.',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Path to the file (Claude Code style)' },
            content: { type: 'string', description: 'Content to write' },
          },
          required: ['path', 'content'],
        },
      },
      execute: async (input, context: ToolContext) => {
        try {
          const cwd = context?.cwd ?? projectRoot;
          const filePath = resolveClaudeCodePath(projectRoot, cwd, input.path as string);
          await mkdir(dirname(filePath), { recursive: true });
          await writeFile(filePath, input.content as string, 'utf-8');
          return { content: `Written ${(input.content as string).length} bytes to ${filePath}` };
        } catch (err) {
          return { content: `Error: ${err instanceof Error ? err.message : String(err)}`, isError: true };
        }
      },
    },
    {
      definition: {
        name: 'list_files',
        group: ToolGroup.File,
        description: 'List files and directories in a given path. ' +
          'Use "/path" for project-root-relative, "path" for cwd-relative, "//abs/path" for absolute.',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Directory path (Claude Code style, default: ".")' },
          },
        },
      },
      execute: async (input, context: ToolContext) => {
        try {
          const cwd = context?.cwd ?? projectRoot;
          const dirPath = resolveClaudeCodePath(projectRoot, cwd, (input.path as string) ?? '.');
          const entries = await readdir(dirPath, { withFileTypes: true });
          const lines = entries.map(e => {
            const prefix = e.isDirectory() ? '📁 ' : '📄 ';
            return `${prefix}${e.name}`;
          });
          return { content: lines.join('\n') || '(empty directory)' };
        } catch (err) {
          return { content: `Error: ${err instanceof Error ? err.message : String(err)}`, isError: true };
        }
      },
    },
  ];
}
