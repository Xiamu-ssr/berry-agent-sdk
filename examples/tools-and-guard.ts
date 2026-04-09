/**
 * Berry Agent SDK — Tools + Guard Example
 * Agent with tools and a permission guard.
 */
import { Agent, type ToolRegistration, type ToolGuard } from '@berry-agent/core';
import { readFile, writeFile, stat } from 'node:fs/promises';

// Define tools
const readFileTool: ToolRegistration = {
  definition: {
    name: 'read_file',
    description: 'Read a file from disk',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
  },
  execute: async (input) => {
    try {
      const content = await readFile(input.path as string, 'utf-8');
      return { content };
    } catch (err) {
      return { content: `Error: ${err}`, isError: true };
    }
  },
};

const writeFileTool: ToolRegistration = {
  definition: {
    name: 'write_file',
    description: 'Write content to a file',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string' },
      },
      required: ['path', 'content'],
    },
  },
  execute: async (input) => {
    await writeFile(input.path as string, input.content as string, 'utf-8');
    return { content: `Wrote ${(input.content as string).length} bytes to ${input.path}` };
  },
};

// Permission guard: deny writes outside cwd
const directoryGuard: ToolGuard = async ({ toolName, input }) => {
  if (toolName === 'write_file') {
    const path = input.path as string;
    if (!path.startsWith(process.cwd())) {
      return { action: 'deny', reason: `Write outside cwd blocked: ${path}` };
    }
  }
  return { action: 'allow' };
};

const agent = new Agent({
  provider: {
    type: 'anthropic',
    apiKey: process.env.ANTHROPIC_API_KEY!,
    model: 'claude-sonnet-4-20250514',
  },
  systemPrompt: 'You are a file management assistant. Help the user read and write files.',
  tools: [readFileTool, writeFileTool],
  toolGuard: directoryGuard,
  onEvent: (event) => {
    if (event.type === 'tool_call') console.log(`🔧 ${event.name}(${JSON.stringify(event.input)})`);
    if (event.type === 'tool_result') console.log(`  → ${event.isError ? '❌' : '✅'}`);
    if (event.type === 'text_delta') process.stdout.write(event.text);
  },
});

const result = await agent.query('Read package.json and tell me the project name', {
  stream: true,
});

console.log(`\n\nDone. Tool calls: ${result.toolCalls}`);
