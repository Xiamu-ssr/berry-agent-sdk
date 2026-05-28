// ============================================================
// @berry-agent/runtime — Managed Runtime Assembly
// ============================================================
// Host products choose roots, credentials, model registry, and host tools.
// The SDK owns how those stable pieces become a managed Agent runtime:
// provider resolver, compaction window, local workspace hand, file memory,
// safety guard, observe collector, skills, and environment system prompt.

import type {
  AgentEvent,
  AgentHome,
  CredentialStore,
  ExecutionEnvironment,
  ExecutionEnvironmentProvider,
  HandCapabilityAuditSink,
  HandCapabilityPolicy,
  HandKind,
  ManagedAgentRuntime,
  PromptPackInput,
  ReasoningEffort,
  SkillDirSpec,
  SystemPromptInput,
  ToolRegistration,
  AgentScope,
} from '@berry-agent/core';
import type { ModelsRegistry, SelectProviderOptions } from '@berry-agent/models';
import type { ModelPricing, Observer } from '@berry-agent/observe';
import type {
  AskBridge,
  SafeNamespaceConfig,
  SafetyLevel,
} from '@berry-agent/safe';
import type { LocalWorkspaceHandOptions } from '@berry-agent/tools-common';
import {
  buildManagedRuntimeAsync,
  buildManagedRuntimeSync,
} from './build.js';

export {
  ManagedRuntimeRegistry,
} from './registry.js';
export {
  ManagedRuntimeWakeScheduler,
} from './scheduler.js';
export {
  ManagedRuntimeSupervisor,
} from './supervisor.js';
export {
  FileRuntimeOrchestrationStore,
  MemoryRuntimeOrchestrationStore,
  RUNTIME_ORCHESTRATION_FILENAME,
  RuntimeOrchestrator,
  createFileRuntimeOrchestrationStore,
  parseRuntimeOrchestrationSnapshot,
  runtimeOrchestrationPath,
} from './orchestration.js';
export type {
  ManagedRuntimeMount,
  ManagedRuntimeMountFactory,
  ManagedRuntimeMountInput,
  ManagedRuntimeRegistryOptions,
} from './registry.js';
export type {
  ManagedRuntimeWakeSchedulerOptions,
} from './scheduler.js';
export type {
  ManagedRuntimeSupervisorOptions,
  ManagedRuntimeSupervisorStartInput,
  ManagedRuntimeSupervisorStartResult,
  ManagedRuntimeSupervisorWorkerOptions,
} from './supervisor.js';
export type {
  AcquireRuntimeLeaseInput,
  AcquireRuntimeLeaseResult,
  ClaimDueWakesOptions,
  EvictStaleWorkersResult,
  RegisterRuntimeWorkerInput,
  RuntimeLease,
  RuntimeLeaseState,
  RuntimeOrchestrationMutator,
  RuntimeOrchestrationMutatorResult,
  RuntimeOrchestrationSnapshot,
  RuntimeOrchestrationStore,
  RuntimeOrchestratorOptions,
  RuntimeWake,
  RuntimeWakeState,
  RuntimeWorker,
  RuntimeWorkerCapacityReport,
  RuntimeWorkerState,
  ScheduleRuntimeWakeInput,
} from './orchestration.js';

// Public assembly utilities — kept re-exported from build.ts so existing
// consumers (host products embedding the env block in their own prompts)
// don't break.
export { buildEnvironmentContext, createEnvironmentSystemPrompt } from './build.js';

export interface ManagedRuntimeBuildOptions {
  agentId: string;
  workspace: string;
  home: AgentHome;
  registry: ModelsRegistry;
  credentials: CredentialStore;
  model: string;
  projectRoot?: string;
  reasoningEffort?: ReasoningEffort;
  promptPack?: PromptPackInput;
  promptPackDir?: string;
  systemPrompt?: SystemPromptInput;
  toolDenylist?: string[];
  /**
   * Host-selected execution surface for shell/process and environment-native
   * hands. This can be local, an OS sandbox, a container, or remote runner.
   */
  executionEnvironment?: ExecutionEnvironment;
  /**
   * SDK orchestration hook for provisioning the execution surface from one
   * stable scope fact source. Use this for local sandbox, container, or remote
   * worker allocation. Mutually exclusive with `executionEnvironment`.
   */
  executionEnvironmentProvider?: ExecutionEnvironmentProvider;
  /**
   * Who releases `executionEnvironment.dispose()`. Defaults to `host` when a
   * host supplies a concrete environment, and `runtime` for SDK-provisioned
   * environments or the SDK-created default.
   */
  executionEnvironmentLifetime?: 'host' | 'runtime';
  localWorkspace?: false | Omit<LocalWorkspaceHandOptions, 'scope' | 'credentials' | 'environment' | 'sandbox'>;
  hostHand?: false | ManagedRuntimeHostHandOptions;
  mcp?: false | ManagedRuntimeMcpOptions;
  /** SDK-owned capability policy applied to local, host, MCP, and environment hands. */
  handPolicy?: HandCapabilityPolicy;
  /** Audit sink for hand capability exposure/execution decisions. */
  handAuditSink?: HandCapabilityAuditSink;
  skills?: ManagedRuntimeSkillLoadout;
  safety?: ManagedRuntimeSafetyOptions;
  observe?: ManagedRuntimeObserveOptions;
  onEvent?: (event: AgentEvent) => void;
  onStatusChange?: () => void;
  onProviderRotate?: SelectProviderOptions['onRotate'];
  logger?: Pick<Console, 'log' | 'warn'>;
}

export interface ManagedRuntimeHostHandOptions {
  id?: string;
  kind?: HandKind;
  displayName?: string;
  tools: ToolRegistration[];
}

export interface ManagedRuntimeMcpOptions {
  /**
   * Seed the SDK-owned agent-local `.mcp.json` with the standard Playwright
   * MCP template when the file does not exist. Host products still decide
   * whether they want this default; the template and write semantics live in
   * the SDK MCP/runtime layer.
   */
  ensureDefaultConfig?: boolean;
}

export interface ManagedRuntimeSkillLoadout {
  /**
   * Per-agent skill directory. Defaults to `home.skillsDir`, which is the
   * SDK-owned agent-local skill pool.
   */
  perAgentDir?: string;
  /** Extra host-selected skill directories. */
  extraDirs?: Array<string | SkillDirSpec>;
  /** Product/global skill pool; installed names are disabled unless enabled. */
  globalDir?: string;
  /** Read-only built-in skill pool shipped by the host product. */
  builtinDir?: string;
  /** Allow-list for installed global/per-agent skill packages. */
  enabled?: string[];
  /** Additional explicit disabled skill names. */
  disabled?: string[];
}

export interface ManagedRuntimeSafetyOptions {
  agentLevel?: SafetyLevel;
  globalLevel?: SafetyLevel;
  classifier?: SafeNamespaceConfig['classifier'];
  askBridge?: AskBridge;
}

export interface ManagedRuntimeObserveOptions {
  observer: Observer;
  pricingOverrides?: Record<string, ModelPricing>;
}

export interface ManagedRuntimeBuildResult {
  runtime: ManagedAgentRuntime;
  workspace: string;
  projectRoot?: string;
  scope: AgentScope;
  executionEnvironment?: ExecutionEnvironment;
  safetyLevel: SafetyLevel;
}

export function createManagedRuntime(options: ManagedRuntimeBuildOptions): ManagedRuntimeBuildResult {
  return buildManagedRuntimeSync(options);
}

export function createManagedRuntimeAsync(options: ManagedRuntimeBuildOptions): Promise<ManagedRuntimeBuildResult> {
  return buildManagedRuntimeAsync(options);
}
