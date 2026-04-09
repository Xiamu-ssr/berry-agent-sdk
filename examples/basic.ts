/**
 * Berry Agent SDK — Basic Example
 * Simple question → answer with streaming.
 */
import { Agent } from '@berry-agent/core';

const agent = new Agent({
  provider: {
    type: 'anthropic',
    apiKey: process.env.ANTHROPIC_API_KEY!,
    model: 'claude-sonnet-4-20250514',
  },
  systemPrompt: 'You are a helpful coding assistant. Be concise.',
  onEvent: (event) => {
    if (event.type === 'text_delta') process.stdout.write(event.text);
    if (event.type === 'api_response') console.log(`\n[tokens: ${event.usage.inputTokens}in / ${event.usage.outputTokens}out]`);
  },
});

const result = await agent.query('What is the difference between map and flatMap in JavaScript?', {
  stream: true,
});

console.log(`\nSession: ${result.sessionId}`);

// Resume the same session
const followUp = await agent.query('Give me an example with arrays', {
  resume: result.sessionId,
  stream: true,
});

console.log(`\nTotal usage: ${followUp.totalUsage.inputTokens}in / ${followUp.totalUsage.outputTokens}out`);
