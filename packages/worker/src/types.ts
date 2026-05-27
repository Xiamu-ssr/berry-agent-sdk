// ============================================================
// @berry-agent/worker — Types
// ============================================================
// Product-agnostic worker spec/environment. A product (Claw or others)
// maps its own AgentEntry/config shape into this minimal contract.

import type {
  AgentHome,
  CredentialStore,
  PromptPackInput,
  ReasoningEffort,
  ToolRegistration,
} from '@berry-agent/core';
import type { ModelsRegistry } from '@berry-agent/models';
import type { ModelPricing, Observer } from '@berry-agent/observe';
import type { AskBridge, SafetyLevel, SafeNamespaceConfig } from '@berry-agent/safe';
import type { ExecutionEnvironmentProvider } from '@berry-agent/core';

/**
 * Minimum input the worker needs to instantiate a managed agent runtime.
 * Anything product-specific (UI state, config screen, registry rows) lives
 * in the host product and is translated into this shape.
 */
export interface WorkerAgentSpec {
  /** Stable agent identity across runs. */
  agentId: string;
  /** Agent-private durable root. */
  workspace: string;
  /** SDK-owned agent home derived from workspace. */
  home: AgentHome;
  /** Optional project root the agent operates on. */
  projectRoot?: string;

  /** Provider/model selection — a tier:X / model:X / bare id ref. */
  model: string;
  /** Reasoning effort hint. */
  reasoningEffort?: ReasoningEffort;
  /** Override the SDK default prompt pack. */
  promptPack?: PromptPackInput;
  /** Tool names refused for this agent regardless of safety guard. */
  toolDenylist?: string[];

  /** Local workspace hand options forwarded to the SDK runtime builder. */
  localWorkspace?: { allowedTools?: string[] } | false;
  /** Host-supplied introspection / control tools mounted as a hand. */
  hostTools?: readonly ToolRegistration[];
  /** Host-supplied display name for the host hand. */
  hostHandDisplayName?: string;

  /** Skill loadout selection. */
  skills?: {
    extraDirs?: string[];
    globalDir?: string;
    builtinDir?: string;
    enabled?: string[];
    disabled?: string[];
  };

  /** Safety guard configuration. */
  safety?: {
    agentLevel?: SafetyLevel;
    globalLevel?: SafetyLevel;
    classifier?: SafeNamespaceConfig['classifier'];
  };

  /** Per-agent execution environment override. Defaults to the worker's
   *  shared sandbox provider when omitted. */
  executionEnvironmentProvider?: ExecutionEnvironmentProvider;

  /** Seed the SDK-owned agent-local `.mcp.json` with the default template. */
  ensureDefaultMcpConfig?: boolean;
}

/**
 * Worker-level shared environment. Constructed once per worker daemon and
 * reused across every agent the worker hosts.
 */
export interface WorkerEnvironment {
  /** Resolve provider config + tier/model references. */
  registry: ModelsRegistry;
  /** Provider/MCP credential lookup. */
  credentials: CredentialStore;
  /** Observe collector (telemetry, cost, audit). */
  observer: Observer;
  /** Default OpenRouter / static pricing overrides. */
  pricingOverrides?: Record<string, ModelPricing>;
  /** Resolve a host-supplied HITL approval bridge per-call. */
  askBridge?: () => AskBridge | undefined;
  /** Default execution environment provider — used when a spec does not pick one. */
  defaultExecutionEnvironmentProvider?: ExecutionEnvironmentProvider;
  /** Optional resolver for additional prompt pack search directory. */
  promptPacksDir?: string;
  /** Logger for provider rotation and sandbox messages. */
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
}

/**
 * Per-spec callbacks the worker emits while a runtime is alive.
 */
export interface WorkerRuntimeHooks {
  onStatusChange?: (agentId: string) => void;
  onProviderRotate?: (
    from: { providerId: string },
    to: { providerId: string },
    error: unknown,
  ) => void;
}
