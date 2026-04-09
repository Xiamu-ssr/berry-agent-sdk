import './load-env.ts';
import { Agent, FileSessionStore } from '@berry-agent/core';

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('Missing ANTHROPIC_API_KEY');
  }

  const agent = new Agent({
    provider: {
      type: 'anthropic',
      apiKey: process.env.ANTHROPIC_API_KEY,
      baseUrl: process.env.ANTHROPIC_BASE_URL,
      model: process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-20250514',
      thinkingBudget: 0,
    },
    systemPrompt: [
      'You are a concise assistant.',
      'If you use tools, explain briefly what you did.',
    ],
    sessionStore: new FileSessionStore('.berry/smoke-anthropic-sessions'),
    onEvent(event) {
      if (event.type === 'text_delta') process.stdout.write(event.text);
      if (event.type === 'tool_call') console.log(`\n[tool] ${event.name}`);
      if (event.type === 'api_response') console.log(`\n[usage]`, event.usage);
    },
  });

  const result = await agent.query(
    process.argv.slice(2).join(' ') || '用一句话解释 Berry Agent SDK 是什么。',
    { stream: true },
  );

  console.log('\n\n[final]', result.text);
  console.log('[session]', result.sessionId);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
