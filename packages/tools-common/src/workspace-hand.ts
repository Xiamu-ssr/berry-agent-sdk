// ============================================================
// Berry Agent SDK — Local Workspace Hand Factory
// ============================================================
// Builds the common local hand used by host products: file/edit/shell/search
// plus web_fetch/web_search. Hosts still choose the AgentScope, sandboxed
// shell executor, credentials, and allowed tool surface.

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
import {
  createWebSearchTool,
  WEB_SEARCH_CREDENTIAL_KEYS,
  type WebSearchProviderName,
} from './web-search.js';
import { createWebFetchTool } from './web-fetch.js';

export interface LocalWorkspaceHandOptions {
  scope: AgentScope;
  credentials: CredentialStore;
  shellOptions?: ShellToolOptions;
  /** Runner boundary for shell/process commands: local, sandbox, container, or remote. */
  environment?: ExecutionEnvironment;
  /** Tool names or tool groups to expose. Undefined means every local workspace tool. */
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

export function createLocalWorkspaceHand(options: LocalWorkspaceHandOptions): Hand {
  const shellOptions = resolveShellOptions(options);
  const tools = [
    ...createLocalToolRegistrations(options.scope, shellOptions),
    createWebFetchTool(),
    createWebSearchTool({
      provider: pickWebSearchProvider(options.credentials) ?? 'tavily',
      credentials: options.credentials,
    }),
  ];

  return createToolRegistrationHand({
    id: options.id ?? 'local-workspace',
    kind: 'local',
    displayName: options.displayName ?? 'Local workspace',
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

function resolveShellOptions(options: LocalWorkspaceHandOptions): ShellToolOptions | undefined {
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

function pickWebSearchProvider(credentials: CredentialStore): WebSearchProviderName | null {
  const order: WebSearchProviderName[] = ['tavily', 'brave', 'serpapi'];
  for (const provider of order) {
    const key = WEB_SEARCH_CREDENTIAL_KEYS[provider];
    if (credentials.get(key)) return provider;
  }
  return null;
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
