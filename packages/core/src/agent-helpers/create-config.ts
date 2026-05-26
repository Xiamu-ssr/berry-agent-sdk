import type { AgentConfig, AgentCreateConfig } from '../agent-config-types.js';
import type { ProviderInput } from '../provider-types.js';

export function agentConfigFromCreateConfig(config: AgentCreateConfig): AgentConfig {
  if (!config.home) {
    throw new Error(
      'Agent.create: `home` is required. Construct `new AgentHome(rootDir)` and pass it in.',
    );
  }

  return {
    provider: resolveCreateProviderInput(config),
    systemPrompt: config.systemPrompt,
    tools: config.tools,
    hands: config.hands,
    skillDirs: config.skillDirs,
    disabledSkills: config.disabledSkills,
    cwd: config.cwd ?? process.cwd(),
    sessionStore: config.sessionStore,
    compaction: config.compaction,
    toolGuard: config.toolGuard,
    eventLogStore: config.eventLogStore,
    home: config.home,
    project: config.project,
    memory: config.memory,
    middleware: config.middleware,
    onEvent: config.onEvent,
    promptPack: config.promptPack,
    promptPackDir: config.promptPackDir,
    enableDelegate: config.enableDelegate,
  };
}

function resolveCreateProviderInput(config: AgentCreateConfig): ProviderInput {
  if (config.provider) return config.provider;
  return {
    type: config.providerType ?? 'anthropic',
    apiKey: config.apiKey!,
    baseUrl: config.baseUrl,
    model: config.model!,
    maxTokens: config.maxTokens,
    thinkingBudget: config.thinkingBudget,
    reasoningEffort: config.reasoningEffort,
  };
}
