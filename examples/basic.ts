// ============================================================
// Berry Agent SDK — Basic Example
// ============================================================
// Shows: create agent → register tool → query with tool loop → resume session

import { Agent } from '@berry-agent/core';
import type { ToolRegistration } from '@berry-agent/core';

// 1. Define a tool
const searchTool: ToolRegistration = {
  definition: {
    name: 'web_search',
    description: 'Search the web for information',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
      },
      required: ['query'],
    },
  },
  execute: async (input) => {
    const query = input.query as string;
    // In real usage, call a search API
    return {
      content: `Search results for "${query}": [mock results]`,
    };
  },
};

// 2. Create agent
const agent = new Agent({
  provider: {
    type: 'anthropic',
    apiKey: process.env.ANTHROPIC_API_KEY!,
    model: 'claude-sonnet-4-20250514',
    // baseUrl: 'https://your-proxy.example.com/v1', // optional: proxy/gateway
  },
  systemPrompt: [
    // Block 1: static instructions (cached)
    'You are a helpful assistant.',
    // Block 2: dynamic context (cached separately)
    'Today is ' + new Date().toISOString().split('T')[0],
  ],
  tools: [searchTool],
  compaction: {
    contextWindow: 200_000,
    // threshold defaults to 85% of contextWindow
  },
  onEvent: (event) => {
    if (event.type === 'tool_call') {
      console.log(`🔧 Tool: ${event.name}`);
    }
    if (event.type === 'api_response') {
      const u = event.usage;
      console.log(`📊 Tokens: ${u.inputTokens} in / ${u.outputTokens} out | cache read: ${u.cacheReadTokens ?? 0}`);
    }
    if (event.type === 'compaction') {
      console.log(`🗜️ Compacted! Freed ${event.tokensFreed} tokens via ${event.layersApplied.join(', ')}`);
    }
  },
});

// 3. Query
async function main() {
  // First query
  const result1 = await agent.query('What is the weather in Tokyo?');
  console.log('\n🤖:', result1.text);
  console.log(`Session: ${result1.sessionId} | Tools: ${result1.toolCalls}`);

  // Resume same session
  const result2 = await agent.query('What about Osaka?', {
    resume: result1.sessionId,
  });
  console.log('\n🤖:', result2.text);

  // Resume with restricted tools
  const result3 = await agent.query('Summarize what you found', {
    resume: result1.sessionId,
    allowedTools: [], // no tools allowed for this query
  });
  console.log('\n🤖:', result3.text);
}

main().catch(console.error);
