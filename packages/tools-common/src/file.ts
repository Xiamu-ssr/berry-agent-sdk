// ============================================================
// Berry Agent SDK — Common Tools: File Operations
// ============================================================

import { readFile, writeFile, readdir, mkdir, stat } from 'node:fs/promises';
import { join, resolve, relative } from 'node:path';
import type { ToolRegistration } from '@berry-agent/core';

/**
 * Create file operation tools scoped to a base directory.
 * Tools: read_file, write_file, list_files
 */
export function createFileTools(baseDir: string): ToolRegistration[] {
  const safePath = (p: string) => {
    const full = resolve(baseDir, p);
    if (!full.startsWith(resolve(baseDir))) {
      throw new Error('Path escapes base directory');
    }
    return full;
  };

  return [
    {
      definition: {
        name: 'read_file',
        description: 'Read the contents of a file. Returns the file content as text.',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Relative path to the file' },
            offset: { type: 'number', description: 'Line number to start reading from (1-indexed)' },
            limit: { type: 'number', description: 'Maximum number of lines to read' },
          },
          required: ['path'],
        },
      },
      execute: async (input) => {
        try {
          const filePath = safePath(input.path as string);
          const content = await readFile(filePath, 'utf-8');
          const lines = content.split('\n');
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
        description: 'Write content to a file. Creates parent directories if needed.',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Relative path to the file' },
            content: { type: 'string', description: 'Content to write' },
          },
          required: ['path', 'content'],
        },
      },
      execute: async (input) => {
        try {
          const filePath = safePath(input.path as string);
          await mkdir(resolve(filePath, '..'), { recursive: true });
          await writeFile(filePath, input.content as string, 'utf-8');
          return { content: `Written ${(input.content as string).length} bytes to ${input.path}` };
        } catch (err) {
          return { content: `Error: ${err instanceof Error ? err.message : String(err)}`, isError: true };
        }
      },
    },
    {
      definition: {
        name: 'list_files',
        description: 'List files and directories in a given path.',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Relative directory path (default: ".")' },
          },
        },
      },
      execute: async (input) => {
        try {
          const dirPath = safePath((input.path as string) ?? '.');
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
