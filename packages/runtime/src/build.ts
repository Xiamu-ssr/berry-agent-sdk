// ============================================================
// Managed runtime assembly machinery
// ============================================================
// Split from `./index.ts` to keep the package barrel small. Public-facing
// factories (`createManagedRuntime` / `createManagedRuntimeAsync`) and the
// option/result interfaces still live in `./index.ts`; this module owns the
// internal helpers that wire scope, execution environment, hands, safety,
// observe collector, skills, and the environment system prompt.

import {
  AgentScope,
  ManagedAgentRuntime,
  SystemPromptCacheMode,
  createToolRegistrationHand,
  listSkillNamesSync,
  type AgentConfig,
  type AgentHome,
  type ExecutionEnvironment,
  type Hand,
  type ProviderInput,
  type SystemPromptInput,
  isolationPolicyFromScope,
  workspaceBindingFromScope,
} from '@berry-agent/core';
import { createFileMemoryProvider } from '@berry-agent/memory-file';
import { ensureDefaultPlaywrightMCPConfig } from '@berry-agent/mcp';
import { inferContextWindow, selectProvider } from '@berry-agent/models';
import { createCollector } from '@berry-agent/observe';
import {
  buildManagedToolGuard,
  resolveClassifierConfig,
  resolveSafetyLevel,
  type ManagedToolGuardOptions,
} from '@berry-agent/safe';
import {
  createLocalWorkspaceHand,
  createSandboxExecutionEnvironment,
} from '@berry-agent/tools-common';
import type {
  ManagedRuntimeBuildOptions,
  ManagedRuntimeBuildResult,
  ManagedRuntimeSkillLoadout,
} from './index.js';

export function buildManagedRuntimeSync(options: ManagedRuntimeBuildOptions): ManagedRuntimeBuildResult {
  const scope = new AgentScope(options.workspace, options.projectRoot);
  const executionEnvironment = resolveExecutionEnvironmentSync(options, scope);
  return assembleManagedRuntime(options, scope, executionEnvironment);
}

export async function buildManagedRuntimeAsync(options: ManagedRuntimeBuildOptions): Promise<ManagedRuntimeBuildResult> {
  const scope = new AgentScope(options.workspace, options.projectRoot);
  const executionEnvironment = await resolveExecutionEnvironmentAsync(options, scope);
  return assembleManagedRuntime(options, scope, executionEnvironment);
}

function assembleManagedRuntime(
  options: ManagedRuntimeBuildOptions,
  scope: AgentScope,
  executionEnvironment: ExecutionEnvironment | undefined,
): ManagedRuntimeBuildResult {
  if (options.mcp !== false && options.mcp?.ensureDefaultConfig) {
    ensureDefaultPlaywrightMCPConfig(options.home.mcpConfigPath);
  }

  const ownsExecutionEnvironment = shouldRuntimeOwnExecutionEnvironment(options);
  const safetyLevel = resolveSafetyLevel(
    options.safety?.agentLevel,
    options.projectRoot,
    options.safety?.globalLevel,
  );
  const collector = options.observe
    ? createCollector({
        db: options.observe.observer.db,
        pricingOverrides: options.observe.pricingOverrides,
        agentId: options.agentId,
      })
    : undefined;

  const runtime = ManagedAgentRuntime.create({
    agentId: options.agentId,
    toolDenylist: options.toolDenylist ?? [],
    config: {
      provider: buildProviderInput(options, options.model),
      model: options.model,
      reasoningEffort: options.reasoningEffort,
      promptPack: options.promptPack,
      promptPackDir: options.promptPackDir,
      modelResolver: (modelRef) => buildProviderInput(options, modelRef),
      systemPrompt: options.systemPrompt ?? createEnvironmentSystemPrompt(options.workspace, options.projectRoot),
      compaction: {
        contextWindow: inferContextWindow(options.model, options.registry),
      },
      hands: buildHands(scope, options, executionEnvironment),
      handPolicy: options.handPolicy,
      handAuditSink: options.handAuditSink,
      cwd: options.projectRoot ?? options.workspace,
      home: options.home,
      project: options.projectRoot,
      memory: createFileMemoryProvider({
        workspaceDir: options.workspace,
        projectDir: options.projectRoot,
      }),
      ...buildSkillLoadout(options.agentId, options.home, options.skills),
      toolGuard: buildManagedToolGuard(safetyLevel, {
        scope,
        askBridge: options.safety?.askBridge,
        agentId: options.agentId,
        classifier: safetyLevel === 'auto' ? buildSafetyClassifier(options) : undefined,
      }),
      middleware: collector ? [collector.middleware] : undefined,
      onEvent: (event) => {
        collector?.eventListener(event);
        options.onEvent?.(event);
        if (event.type === 'status_change') options.onStatusChange?.();
      },
    },
    disposeHooks: ownsExecutionEnvironment && executionEnvironment?.dispose
      ? [() => executionEnvironment.dispose?.()]
      : undefined,
  });

  return {
    runtime,
    workspace: options.workspace,
    projectRoot: options.projectRoot,
    scope,
    executionEnvironment,
    safetyLevel,
  };
}

export function buildEnvironmentContext(workspace: string, projectRoot?: string): string {
  const lines = [
    '<env>',
    "  # workspace is the agent's private directory (memory, sessions, personal notes)",
    `  workspace: ${workspace}`,
  ];
  if (projectRoot) {
    lines.push('  # project is the codebase root this agent operates on');
    lines.push(`  project: ${projectRoot}`);
    lines.push(`  cwd: ${projectRoot}`);
  } else {
    lines.push(`  cwd: ${workspace}`);
  }
  lines.push('</env>');
  return lines.join('\n');
}

export function createEnvironmentSystemPrompt(workspace: string, projectRoot?: string): SystemPromptInput {
  return [
    { text: buildEnvironmentContext(workspace, projectRoot), cache: SystemPromptCacheMode.Stable },
  ];
}

function buildProviderInput(options: ManagedRuntimeBuildOptions, spec: string): ProviderInput {
  return selectProvider(spec, options.registry, {
    onRotate: options.onProviderRotate ?? ((from, to, err) => {
      options.logger?.warn?.(`[agent:${options.agentId}] provider failover: ${from.providerId} -> ${to.providerId}`, err);
    }),
  });
}

function buildHands(
  scope: AgentScope,
  options: ManagedRuntimeBuildOptions,
  executionEnvironment: ExecutionEnvironment | undefined,
): Hand[] {
  const hands: Hand[] = [];

  hands.push(...(executionEnvironment?.createHands?.(scope) ?? []));

  if (options.localWorkspace !== false) {
    hands.push(createLocalWorkspaceHand({
      scope,
      credentials: options.credentials,
      environment: executionEnvironment,
      ...(options.localWorkspace ?? {}),
    }));
  }

  if (options.hostHand !== false && options.hostHand?.tools.length) {
    hands.push(createToolRegistrationHand({
      id: options.hostHand.id ?? 'host-system',
      kind: options.hostHand.kind ?? 'system',
      displayName: options.hostHand.displayName ?? 'Host system',
      tools: options.hostHand.tools,
    }));
  }

  return hands;
}

function resolveExecutionEnvironmentSync(
  options: ManagedRuntimeBuildOptions,
  scope: AgentScope,
): ExecutionEnvironment | undefined {
  if (options.executionEnvironment && options.executionEnvironmentProvider) {
    throw new Error('Specify either executionEnvironment or executionEnvironmentProvider, not both.');
  }
  if (options.executionEnvironment) return options.executionEnvironment;
  if (options.executionEnvironmentProvider) {
    const environment = options.executionEnvironmentProvider.provision(createProvisionRequest(options.agentId, scope));
    if (isPromiseLike(environment)) {
      throw new Error('executionEnvironmentProvider returned a Promise; use createManagedRuntimeAsync instead.');
    }
    return environment;
  }
  if (options.localWorkspace === false) return undefined;
  return createSandboxExecutionEnvironment({ logger: options.logger ?? console });
}

async function resolveExecutionEnvironmentAsync(
  options: ManagedRuntimeBuildOptions,
  scope: AgentScope,
): Promise<ExecutionEnvironment | undefined> {
  if (options.executionEnvironment && options.executionEnvironmentProvider) {
    throw new Error('Specify either executionEnvironment or executionEnvironmentProvider, not both.');
  }
  if (options.executionEnvironment) return options.executionEnvironment;
  if (options.executionEnvironmentProvider) {
    return await options.executionEnvironmentProvider.provision(createProvisionRequest(options.agentId, scope));
  }
  if (options.localWorkspace === false) return undefined;
  return createSandboxExecutionEnvironment({ logger: options.logger ?? console });
}

function createProvisionRequest(agentId: string, scope: AgentScope) {
  return {
    agentId,
    scope,
    binding: workspaceBindingFromScope(scope),
    isolationPolicy: isolationPolicyFromScope(scope),
  };
}

function isPromiseLike<T>(value: T | Promise<T>): value is Promise<T> {
  return typeof value === 'object' && value !== null && 'then' in value;
}

function shouldRuntimeOwnExecutionEnvironment(options: ManagedRuntimeBuildOptions): boolean {
  if (options.executionEnvironmentLifetime) return options.executionEnvironmentLifetime === 'runtime';
  if (options.executionEnvironment) return false;
  if (options.executionEnvironmentProvider) return true;
  return options.localWorkspace !== false;
}

function buildSafetyClassifier(options: ManagedRuntimeBuildOptions): ManagedToolGuardOptions['classifier'] {
  const resolved = resolveClassifierConfig({
    safe: options.safety?.classifier === undefined ? undefined : { classifier: options.safety.classifier },
    registry: options.registry,
  });
  if (!resolved) return undefined;

  const classifier: NonNullable<ManagedToolGuardOptions['classifier']> = {
    modelRef: resolved.modelRef,
    registry: resolved.registry,
  };
  if (options.projectRoot) classifier.projectDir = options.projectRoot;
  if (resolved.skipStage2 !== undefined) classifier.skipStage2 = resolved.skipStage2;
  if (resolved.blockRules !== undefined) classifier.blockRules = resolved.blockRules;
  if (resolved.allowExceptions !== undefined) classifier.allowExceptions = resolved.allowExceptions;
  if (resolved.maxConsecutiveDenials !== undefined) classifier.maxConsecutiveDenials = resolved.maxConsecutiveDenials;
  if (resolved.maxTotalDenials !== undefined) classifier.maxTotalDenials = resolved.maxTotalDenials;
  return classifier;
}

function buildSkillLoadout(
  agentId: string,
  home: AgentHome,
  loadout: ManagedRuntimeSkillLoadout | undefined,
): Pick<AgentConfig, 'skillDirs' | 'disabledSkills'> {
  const perAgentDir = loadout?.perAgentDir ?? home.skillsDir;
  const enabledSet = new Set(loadout?.enabled ?? []);
  const installedGlobal = loadout?.globalDir ? listSkillNamesSync(loadout.globalDir) : [];
  const installedPerAgent = listSkillNamesSync(perAgentDir);

  return {
    skillDirs: [
      { dir: perAgentDir, defaultSource: 'per-agent' as const, defaultAuthorAgent: agentId },
      ...(loadout?.extraDirs ?? []),
      ...(loadout?.globalDir ? [{ dir: loadout.globalDir, defaultSource: 'global' as const }] : []),
      ...(loadout?.builtinDir ? [{ dir: loadout.builtinDir, defaultSource: 'global' as const }] : []),
    ],
    disabledSkills: [
      ...installedGlobal.filter((name) => !enabledSet.has(name)),
      ...installedPerAgent.filter((name) => !enabledSet.has(name)),
      ...(loadout?.disabled ?? []),
    ],
  };
}
