import type { SystemPromptBlock, SystemPromptInput } from '@berry-agent/small-shared-core';
import type { ContentBlock } from '../content-types.js';
import type { QueryResult } from '../agent-runtime-types.js';
import { normalizeSystemPrompt } from '@berry-agent/small-shared-core';
import type { AgentConfig } from '../agent-config-types.js';
import type { ModelRefResolver, Provider, ProviderConfig, ProviderResolver } from '../provider-types.js';
import type { Session, SessionStore } from '../session-types.js';
import type { ToolRegistration } from '../tool-types.js';
import { HandRegistry, type HandToolAdapterOptions } from '../hands.js';
import type { EventLogStore } from '../event-log/types.js';
import { FileEventLogStore } from '../event-log/jsonl-store.js';
import type { AgentMemory, ProjectContext } from '../workspace/types.js';
import type { MemoryProvider } from '../memory/provider.js';
import { FileAgentMemory } from '../workspace/file-memory.js';
import { FileProjectContext } from '../workspace/file-project.js';
import { initWorkspaceSync } from '../workspace/initializer.js';
import type { CompactionStrategy } from '../compaction/types.js';
import { FileSessionStore } from '../session/file-store.js';
import type { AgentHome } from '../agent-home.js';
import { resolvePromptPack, type PromptPack } from '../prompts.js';
import { SkillManager } from './skill-manager.js';
import { AgentWorkspaceData } from './workspace-data.js';
import { createProvider } from './provider.js';
import { resolveInitialProviderRuntime } from './provider-runtime.js';
import { registerConfiguredToolCapabilities } from './capabilities.js';

interface InternalAgentConfig extends AgentConfig {
  _systemPromptOverride?: SystemPromptInput;
}

export interface AgentBootState {
  provider: Provider;
  providerConfig: ProviderConfig;
  providerResolver: ProviderResolver | null;
  modelResolver: ModelRefResolver | null;
  systemPrompt: SystemPromptBlock[];
  tools: Map<string, ToolRegistration>;
  toolDenylist: Set<string>;
  hands: HandRegistry;
  handToolNames: Map<string, Set<string>>;
  handAdapterOptions: HandToolAdapterOptions;
  skills: SkillManager;
  cwd: string;
  sessionStore: SessionStore;
  compactionConfig: AgentConfig['compaction'];
  compactionStrategy?: CompactionStrategy;
  onEvent?: AgentConfig['onEvent'];
  toolGuard: AgentConfig['toolGuard'];
  middleware: NonNullable<AgentConfig['middleware']>;
  eventLogStore?: EventLogStore;
  promptPack: PromptPack;
  memory?: AgentMemory;
  memoryProvider?: MemoryProvider;
  memoryReady: Promise<void>;
  projectContext?: ProjectContext;
  workspaceData: AgentWorkspaceData;
  home: AgentHome;
  onQueryStart?: (session: Session, prompt: string | ContentBlock[]) => void | Promise<void>;
  onQueryEnd?: (session: Session, result: QueryResult) => void | Promise<void>;
}

export function bootAgent(config: AgentConfig): AgentBootState {
  const internal = config as InternalAgentConfig;
  const home = requireAgentHome(config.home);
  const promptPack = resolvePromptPack(config.promptPack, { directory: config.promptPackDir });
  const systemPrompt = normalizeSystemPrompt(
    internal._systemPromptOverride
      ?? config.systemPrompt
      ?? promptPack.baseAgent,
  );

  const metadata = initWorkspaceSync(home.root, {
    model: config.model,
    reasoningEffort: config.reasoningEffort,
    compaction: config.compaction,
    skills: config.skillDirs
      ? { extraDirs: config.skillDirs.map((entry) => (typeof entry === 'string' ? entry : entry.dir)) }
      : undefined,
  });

  const modelResolver = config.modelResolver ?? null;
  const providerRuntime = resolveInitialProviderRuntime({
    provider: config.provider,
    metadataModel: metadata.model,
    modelResolver,
    reasoningEffort: metadata.reasoningEffort,
  });
  const provider = config.providerInstance ?? createProvider(providerRuntime.providerConfig);
  const memory = new FileAgentMemory(home.root);
  const memoryProvider = config.memory;
  const projectContext = config.project ? new FileProjectContext(config.project) : undefined;
  const tools = new Map<string, ToolRegistration>();
  const hands = new HandRegistry();
  const handToolNames = new Map<string, Set<string>>();
  const handAdapterOptions: HandToolAdapterOptions = {
    policy: config.handPolicy,
    auditSink: config.handAuditSink,
  };
  registerConfiguredToolCapabilities({ tools, hands, handToolNames }, config.tools, handAdapterOptions);

  return {
    provider,
    providerConfig: providerRuntime.providerConfig,
    providerResolver: providerRuntime.providerResolver,
    modelResolver,
    systemPrompt,
    tools,
    toolDenylist: new Set(metadata.toolDenylist ?? []),
    hands,
    handToolNames,
    handAdapterOptions,
    skills: new SkillManager({
      skillDirs: (metadata.skills?.extraDirs ?? []).map((dir) => ({ dir })),
      disabledSkills: new Set(config.disabledSkills ?? []),
    }),
    cwd: config.cwd ?? process.cwd(),
    sessionStore: config.sessionStore ?? new FileSessionStore(home.sessionsDir),
    compactionConfig: metadata.compaction,
    compactionStrategy: config.compactionStrategy,
    onEvent: config.onEvent,
    toolGuard: config.toolGuard,
    middleware: config.middleware ?? [],
    eventLogStore: config.eventLogStore ?? new FileEventLogStore(home.sessionsDir),
    promptPack,
    memory,
    memoryProvider,
    memoryReady: memoryProvider?.init?.({
      agentId: metadata.id,
      workspaceDir: home.root,
      dataDir: home.root,
    }) ?? Promise.resolve(),
    projectContext,
    workspaceData: new AgentWorkspaceData({
      home,
      memory: () => memory,
      projectContext: () => projectContext,
    }),
    home,
    onQueryStart: config.onQueryStart,
    onQueryEnd: config.onQueryEnd,
  };
}

function requireAgentHome(home: AgentHome | undefined): AgentHome {
  if (!home) {
    throw new Error(
      'AgentConfig.home is required. Construct `new AgentHome(rootDir)` and pass it in.',
    );
  }
  return home;
}
