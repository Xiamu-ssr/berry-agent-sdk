// ============================================================
// @berry-agent/worker — Runtime Builder
// ============================================================
// Builds a SDK ManagedAgentRuntime from a product-agnostic WorkerAgentSpec
// + shared WorkerEnvironment. This is the "worker daemon's core job":
// taking a small agent spec and assembling a fully-wired SDK runtime.

import { mkdirSync, existsSync } from 'node:fs';
import type { ManagedAgentRuntime } from '@berry-agent/core';
import { createManagedRuntime } from '@berry-agent/runtime';
import { createSandboxExecutionEnvironmentProvider } from '@berry-agent/tools-common';
import type {
  WorkerAgentSpec,
  WorkerEnvironment,
  WorkerRuntimeHooks,
} from './types.js';

export interface BuiltWorkerRuntime {
  runtime: ManagedAgentRuntime;
  workspace: string;
  projectRoot?: string;
}

/**
 * Assemble a managed agent runtime from a spec + worker environment.
 *
 * The worker owns the boring infrastructure choices (default sandbox provider,
 * project dir creation, provider rotation logger). The product layer (Claw or
 * any other host) decides what goes into the WorkerAgentSpec.
 */
export function buildAgentRuntime(
  spec: WorkerAgentSpec,
  env: WorkerEnvironment,
  hooks: WorkerRuntimeHooks = {},
): BuiltWorkerRuntime {
  if (spec.projectRoot && !existsSync(spec.projectRoot)) {
    mkdirSync(spec.projectRoot, { recursive: true });
  }

  const executionEnvironmentProvider =
    spec.executionEnvironmentProvider
    ?? env.defaultExecutionEnvironmentProvider
    ?? createSandboxExecutionEnvironmentProvider({ logger: env.logger ?? console });

  const { runtime } = createManagedRuntime({
    agentId: spec.agentId,
    workspace: spec.workspace,
    projectRoot: spec.projectRoot,
    home: spec.home,
    registry: env.registry,
    credentials: env.credentials,
    model: spec.model,
    reasoningEffort: spec.reasoningEffort,
    promptPack: spec.promptPack,
    promptPackDir: env.promptPacksDir,
    toolDenylist: spec.toolDenylist ?? [],
    executionEnvironmentProvider,
    localWorkspace: spec.localWorkspace === false
      ? false
      : { allowedTools: spec.localWorkspace?.allowedTools },
    hostHand: spec.hostTools && spec.hostTools.length > 0
      ? {
          id: 'worker-host',
          kind: 'system',
          displayName: spec.hostHandDisplayName ?? 'Worker host',
          tools: [...spec.hostTools],
        }
      : false,
    mcp: spec.ensureDefaultMcpConfig === false
      ? false
      : { ensureDefaultConfig: true },
    skills: spec.skills,
    safety: {
      agentLevel: spec.safety?.agentLevel,
      globalLevel: spec.safety?.globalLevel,
      classifier: spec.safety?.classifier,
      askBridge: env.askBridge?.(),
    },
    observe: {
      observer: env.observer,
      pricingOverrides: env.pricingOverrides,
    },
    onProviderRotate: hooks.onProviderRotate ?? ((from, to, err) => {
      (env.logger ?? console).warn?.(
        `[agent:${spec.agentId}] provider failover: ${from.providerId} -> ${to.providerId}`,
        err,
      );
    }),
    onStatusChange: () => hooks.onStatusChange?.(spec.agentId),
  });

  return {
    runtime,
    workspace: spec.workspace,
    projectRoot: spec.projectRoot,
  };
}
