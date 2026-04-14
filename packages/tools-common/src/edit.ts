// ============================================================
// Berry Agent SDK — Common Tools: Edit File
// ============================================================

import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { TOOL_EDIT_FILE } from '@berry-agent/core';
import type { ToolRegistration } from '@berry-agent/core';

interface Edit {
  oldText: string;
  newText: string;
}

/**
 * Create an edit_file tool scoped to a base directory.
 * Performs exact text replacements — each oldText must be unique in the file.
 */
export function createEditFileTool(baseDir: string): ToolRegistration {
  const safePath = (p: string) => {
    const full = resolve(baseDir, p);
    if (!full.startsWith(resolve(baseDir))) {
      throw new Error('Path escapes base directory');
    }
    return full;
  };

  return {
    definition: {
      name: TOOL_EDIT_FILE,
      description:
        'Apply exact text replacements to a file. Each oldText must appear exactly once in the file.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative path to the file' },
          edits: {
            type: 'array',
            description: 'Array of { oldText, newText } replacements',
            items: {
              type: 'object',
              properties: {
                oldText: { type: 'string', description: 'Exact text to find (must be unique)' },
                newText: { type: 'string', description: 'Replacement text' },
              },
              required: ['oldText', 'newText'],
            },
          },
        },
        required: ['path', 'edits'],
      },
    },
    execute: async (input) => {
      try {
        const filePath = safePath(input.path as string);
        const edits = input.edits as Edit[];
        let content = await readFile(filePath, 'utf-8');
        const applied: string[] = [];

        for (const edit of edits) {
          const idx = content.indexOf(edit.oldText);
          if (idx === -1) {
            return {
              content: `Error: oldText not found in file:\n${edit.oldText.slice(0, 200)}`,
              isError: true,
            };
          }
          // Check uniqueness — search for a second occurrence
          const secondIdx = content.indexOf(edit.oldText, idx + 1);
          if (secondIdx !== -1) {
            return {
              content: `Error: oldText appears multiple times in file (not unique):\n${edit.oldText.slice(0, 200)}`,
              isError: true,
            };
          }
          content = content.slice(0, idx) + edit.newText + content.slice(idx + edit.oldText.length);
          applied.push(
            `-${edit.oldText.split('\n').length} lines` +
            ` +${edit.newText.split('\n').length} lines`,
          );
        }

        await writeFile(filePath, content, 'utf-8');
        return { content: `Applied ${edits.length} edit(s) to ${input.path}:\n${applied.join('\n')}` };
      } catch (err) {
        return { content: `Error: ${err instanceof Error ? err.message : String(err)}`, isError: true };
      }
    },
  };
}
