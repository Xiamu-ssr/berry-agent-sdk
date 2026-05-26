import type { SystemPromptInput } from '@berry-agent/small-shared-core';
import type { SkillDirSpec } from './skills/types.js';
import type { Hand } from './hands.js';
import type { ContentBlock } from './content-types.js';
import type { Session, SessionStore } from './session-types.js';
import type { ToolGuard, ToolRegistration } from './tool-types.js';
import type { CompactionConfig, CompactionStrategy } from './compaction/types.js';
import type {
  ModelRefResolver,
  Provider,
  ProviderInput,
  ProviderType,
} from './provider-types.js';
import type { AgentEvent, Middleware, QueryResult } from './agent-runtime-types.js';
import type { AgentHome } from './agent-home.js';
import type { EventLogStore } from './event-log/types.js';
import type { MemoryProvider } from './memory/provider.js';
import type { PromptPackInput } from './prompts.js';

export interface AgentConfig {
  /** Provider config, or a resolver. Static configs still work unchanged. */
  provider: ProviderInput;
  /**
   * Model reference string seeded into agent.json on first launch. On
   * subsequent launches the on-disk `model` field is authoritative.
   */
  model?: string;
  /** Resolve model refs from agent.json / switchModel into ProviderInput. */
  modelResolver?: ModelRefResolver;
  /** Unified reasoning effort level injected into provider config. */
  reasoningEffort?: 'none' | 'low' | 'medium' | 'high' | 'max' | 'xhigh';
  /** Optional injected provider instance for tests/custom providers. */
  providerInstance?: Provider;
  /** Execution surfaces that expose capabilities to the agent. */
  hands?: Hand[];
  /** Direct tool registrations. */
  tools?: ToolRegistration[];
  /** Directories containing skills. */
  skillDirs?: Array<string | SkillDirSpec>;
  /** Skill names to exclude from loading. */
  disabledSkills?: string[];
  /** Working directory for tool execution. */
  cwd?: string;
  /** Compaction config. */
  compaction?: CompactionConfig;
  /** SDK prompt pack id/object for base behavior, compaction, and memory flush prompts. */
  promptPack?: PromptPackInput;
  /** Optional base system prompt blocks for this agent instance. */
  systemPrompt?: SystemPromptInput;
  /** Optional prompt-pack data directory. */
  promptPackDir?: string;
  /** Session store; defaults to AgentHome.sessionsDir. */
  sessionStore?: SessionStore;
  /** Event handler for streaming / logging. */
  onEvent?: (event: AgentEvent) => void;
  /** Middleware pipeline. */
  middleware?: Middleware[];
  /** Tool execution guard. */
  toolGuard?: ToolGuard;
  /** Append-only session event log. */
  eventLogStore?: EventLogStore;
  /**
   * Required structured directory layout. Products choose the root; SDK owns
   * subpaths and on-disk structure.
   */
  home: AgentHome;
  /** Pluggable MemoryProvider. */
  memory?: MemoryProvider;
  /** Optional project root binding for shared project context. */
  project?: string;
  /** Enable built-in delegate tool. */
  enableDelegate?: boolean;
  /** Custom compaction strategy. */
  compactionStrategy?: CompactionStrategy;
  /** Called at the start of each query after session resolution. */
  onQueryStart?: (session: Session, prompt: string | ContentBlock[]) => void | Promise<void>;
  /** Called at the end of each query before return. */
  onQueryEnd?: (session: Session, result: QueryResult) => void | Promise<void>;
}

/**
 * Simplified config for `Agent.create()`. Prefer full provider config/resolver;
 * shorthand fields exist for tests and small embeddings.
 */
export interface AgentCreateConfig {
  provider?: ProviderInput;
  providerType?: ProviderType;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  maxTokens?: number;
  thinkingBudget?: number;
  reasoningEffort?: 'none' | 'low' | 'medium' | 'high' | 'max' | 'xhigh';

  systemPrompt?: SystemPromptInput;
  tools?: ToolRegistration[];
  hands?: Hand[];
  skillDirs?: Array<string | SkillDirSpec>;
  disabledSkills?: string[];
  cwd?: string;
  sessionStore?: SessionStore;
  compaction?: CompactionConfig;
  promptPack?: PromptPackInput;
  promptPackDir?: string;
  toolGuard?: ToolGuard;
  eventLogStore?: EventLogStore;
  home: AgentHome;
  memory?: MemoryProvider;
  project?: string;
  middleware?: Middleware[];
  onEvent?: (event: AgentEvent) => void;
  enableDelegate?: boolean;
}
