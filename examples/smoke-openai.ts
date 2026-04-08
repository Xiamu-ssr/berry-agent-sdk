import { Agent, FileSessionStore } from '@berry-agent/core';

async function main() {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('Missing OPENAI_API_KEY');
  }

  const agent = new Agent({
    provider: {
      type: 'openai',
      apiKey: process.env.OPENAI_API_KEY,
      baseUrl: process.env.OPENAI_BASE_URL,
      model: process.env.OPENAI_MODEL ?? 'gpt-5.4',
    },
    systemPrompt: [
      'You are a concise assistant.',
      'Prefer short, direct answers.',
    ],
    sessionStore: new FileSessionStore('.berry/smoke-openai-sessions'),
    onEvent(event) {
      if (event.type === 'text_delta') process.stdout.write(event.text);
      if (event.type === 'tool_call') console.log(`\n[tool] ${event.name}`);
      if (event.type === 'api_response') console.log(`\n[usage]`, event.usage);
    },
  });

  const result = await agent.query(
    process.argv.slice(2).join(' ') || 'Explain Berry Agent SDK in one sentence.',
    { stream: true },
  );

  console.log('\n\n[final]', result.text);
  console.log('[session]', result.sessionId);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
