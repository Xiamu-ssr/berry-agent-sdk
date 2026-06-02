// ============================================================
// Berry Agent SDK — Workspace Tools Hand + Sandbox Environment
// ============================================================
// The workspace tools hand bundles the capabilities that *land on a
// machine's filesystem*: file, edit, shell, search. Its executor comes
// from an ExecutionEnvironment (local OS sandbox by default; a container /
// remote / polling env when the host supplies one). This is the brain's
// primary work hand — the same shape a remote machine's exec hand has
// (env's executor → workspace tools), just built for the local/primary env.
//
// Web tools (web_fetch / web_search) are NOT here — they touch no machine,
// hold no executor, and are an agent-level env-less hand (see web-hand.ts).
// Keeping them apart is the 新-1 fix: "needs a kitchen" vs "needs no
// kitchen" must not be packed into one hand.

import {
  AgentScope,
  createExecutionEnvironment,
  createToolRegistrationHand,
  isolationPolicyFromScope,
  type CredentialStore,
  type ExecutionEnvironment,
  type ExecutionEnvironmentProvider,
  type Hand,
  type ToolRegistration,
} from '@berry-agent/core';
import { createSandbox } from '@berry-agent/safe';
import { createLocalToolRegistrations } from './local-tools.js';
import type { ShellToolOptions } from './shell.js';

export interface WorkspaceToolsHandOptions {
  scope: AgentScope;
  shellOptions?: ShellToolOptions;
  /** Runner boundary for shell/process commands: local, sandbox, container, or remote. */
  environment?: ExecutionEnvironment;
  /** Tool names or tool groups to expose. Undefined means every workspace tool. */
  allowedTools?: string[];
  /** Create the default SDK OS-sandbox execution environment from the AgentScope. */
  sandbox?: boolean | LocalWorkspaceSandboxOptions;
  id?: string;
  displayName?: string;
}

export interface LocalWorkspaceSandboxOptions {
  enabled?: boolean;
  logger?: Pick<Console, 'log' | 'warn'>;
  platform?: 'macos' | 'linux';
}

/**
 * Build the workspace tools hand: file / edit / shell / search, all bound
 * to one execution environment's executor. The brain sees `shell`,
 * `read_file`, etc. and never knows which pipe (local sandbox / container /
 * remote machine) sits behind them.
 */
export function createWorkspaceToolsHand(options: WorkspaceToolsHandOptions): Hand {
  const shellOptions = resolveShellOptions(options);
  const tools = createLocalToolRegistrations(options.scope, shellOptions);

  return createToolRegistrationHand({
    id: options.id ?? 'workspace',
    kind: 'local',
    displayName: options.displayName ?? 'Workspace',
    tools: filterTools(tools, options.allowedTools),
  });
}

export function createSandboxedShellOptions(
  scope: AgentScope,
  options: LocalWorkspaceSandboxOptions = {},
): ShellToolOptions {
  if (options.enabled === false) return {};

  const executor = createSandboxExecutionEnvironment(options).createCommandExecutor?.(scope);
  return executor ? { executor } : {};
}

export function createSandboxExecutionEnvironment(
  options: LocalWorkspaceSandboxOptions = {},
): ExecutionEnvironment {
  const logger = options.logger;
  return createExecutionEnvironment({
    id: 'local-os-sandbox',
    kind: 'os-sandbox',
    displayName: 'Local OS sandbox',
    isolationPolicy: (scope) => isolationPolicyFromScope(scope),
    createCommandExecutor: (scope) => {
      if (options.enabled === false) return null;
      const executor = createSandbox({
        ...isolationPolicyFromScope(scope),
        platform: options.platform,
      });
      if (!executor) {
        logger?.warn?.(`[sandbox] OS sandbox not available on ${process.platform}. Shell commands run unsandboxed.`);
        return null;
      }

      logger?.log?.(`[sandbox] Shell commands run inside OS sandbox (platform: ${process.platform})`);
      logger?.log?.(`[sandbox] Writable: ${scope.writableRoots.join(', ')}`);
      return executor;
    },
  });
}

export function createSandboxExecutionEnvironmentProvider(
  options: LocalWorkspaceSandboxOptions = {},
): ExecutionEnvironmentProvider {
  return {
    provision: () => createSandboxExecutionEnvironment(options),
  };
}

function resolveShellOptions(options: WorkspaceToolsHandOptions): ShellToolOptions | undefined {
  if (options.shellOptions) return options.shellOptions;

  const environmentExecutor = options.environment?.createCommandExecutor?.(options.scope);
  if (environmentExecutor) return { executor: environmentExecutor };

  if (options.sandbox) {
    return createSandboxedShellOptions(options.scope, normalizeSandboxOptions(options.sandbox));
  }

  return undefined;
}

function normalizeSandboxOptions(value: boolean | LocalWorkspaceSandboxOptions): LocalWorkspaceSandboxOptions {
  return typeof value === 'boolean' ? { enabled: value } : value;
}

function filterTools(tools: ToolRegistration[], allowedTools?: string[]): ToolRegistration[] {
  if (allowedTools === undefined) return tools;
  const groupToNames = new Map<string, string[]>();
  for (const tool of tools) {
    const group = tool.definition.group ?? 'other';
    if (!groupToNames.has(group)) groupToNames.set(group, []);
    groupToNames.get(group)!.push(tool.definition.name);
  }
  const allowedToolNames = new Set(
    allowedTools.flatMap((name) => groupToNames.get(name) ?? [name]),
  );
  return tools.filter((tool) => allowedToolNames.has(tool.definition.name));
}

// Re-export for callers that still type against the credential store shape
// when assembling web hands alongside workspace hands.
export type { CredentialStore };
