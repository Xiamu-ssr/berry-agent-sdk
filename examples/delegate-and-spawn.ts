/**
 * Berry Agent SDK — Delegate + Spawn Example
 * One-shot delegation (with cache sharing) and persistent sub-agents.
 */
import { Agent, type ToolRegistration } from '@berry-agent/core';

const readFileTool: ToolRegistration = {
  definition: {
    name: 'read_file',
    description: 'Read a file',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
  },
  execute: async (input) => {
    const { readFile } = await import('node:fs/promises');
    const content = await readFile(input.path as string, 'utf-8');
    return { content };
  },
};

const agent = new Agent({
  provider: {
    type: 'anthropic',
    apiKey: process.env.ANTHROPIC_API_KEY!,
    model: 'claude-sonnet-4-20250514',
  },
  systemPrompt: 'You are a senior developer.',
  tools: [readFileTool],
});

// === 1. Have a conversation first ===
console.log('=== Main conversation ===');
const q1 = await agent.query('I am working on a TypeScript SDK called Berry Agent.');
console.log(`Main: ${q1.text.slice(0, 100)}...`);

// === 2. Delegate: one-shot fork (shares cache with main conversation) ===
console.log('\n=== Delegate: code review ===');
const reviewResult = await agent.delegate(
  'Review the package.json file and suggest improvements.',
  {
    // Append skill-like instructions to the system prompt
    appendSystemPrompt: `
You are now acting as a code reviewer. Focus on:
- Dependency hygiene
- Missing scripts
- Version strategy
`,
    onEvent: (event) => {
      if (event.type === 'tool_call') console.log(`  🔧 ${event.name}`);
      if (event.type === 'text_delta') process.stdout.write(event.text);
    },
  },
);
console.log(`\n  [Delegate: ${reviewResult.turns} turns, ${reviewResult.toolCalls} tool calls, ${reviewResult.usage.inputTokens}in / ${reviewResult.usage.outputTokens}out tokens]`);

// === 3. Spawn: persistent sub-agent (independent session) ===
console.log('\n=== Spawn: research assistant ===');
const researcher = agent.spawn({
  id: 'researcher',
  systemPrompt: 'You are a research assistant. Provide concise summaries.',
  // Uses a cheaper model
  model: 'claude-sonnet-4-20250514',
});

const r1 = await researcher.query('What is prompt caching in the Anthropic API?');
console.log(`Researcher: ${r1.text.slice(0, 200)}...`);

// The researcher has its own session — can have multi-turn conversations
const r2 = await researcher.query('How does it compare to OpenAI\'s cached_tokens?', {
  resume: r1.sessionId,
});
console.log(`Researcher follow-up: ${r2.text.slice(0, 200)}...`);

// Clean up
agent.destroyChild('researcher');
console.log(`\nChildren remaining: ${agent.children.size}`);
