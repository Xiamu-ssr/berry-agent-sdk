// ============================================================
// Berry Agent SDK — Common Tools: Public API
// ============================================================
//
// Usage:
//   import { createManagedRuntime } from '@berry-agent/runtime';
//   import { createLocalWorkspaceHand } from '@berry-agent/tools-common';
//
//   const { runtime } = createManagedRuntime({
//     // ...workspace, home, registry, credentials, model
//     localWorkspace: { /* options */ },
//   });

export { createFileTools } from './file.js';
export { createShellTool, createShellTools } from './shell.js';
export type { ShellToolOptions } from './shell.js';
export { NodeExecutor } from './executor.js';
export type { CommandExecutor, ExecOptions, ExecResult, SpawnOptions, ProcessHandle } from '@berry-agent/core';
export { createSearchTools } from './search.js';
export type { SearchToolOptions } from './search.js';
export { createEditFileTool } from './edit.js';
export { createWebFetchTool } from './web-fetch.js';
export { createWebSearchTool } from './web-search.js';
export type { SearchProvider, SearchResult, WebSearchConfig, WebSearchProviderName, CredentialKeyMeta } from './web-search.js';
export { WEB_SEARCH_CREDENTIAL_KEYS, WEB_SEARCH_CREDENTIAL_META } from './web-search.js';
export {
  createLocalWorkspaceHand,
  createSandboxExecutionEnvironment,
  createSandboxExecutionEnvironmentProvider,
  createSandboxedShellOptions,
} from './workspace-hand.js';
export type { LocalWorkspaceHandOptions, LocalWorkspaceSandboxOptions } from './workspace-hand.js';

// Container / remote runners — alternative ExecutionEnvironment implementations
// for hosts that want to move command execution off the local machine.
export {
  createContainerExecutionEnvironment,
  createContainerExecutionEnvironmentProvider,
  createDefaultDockerDriver,
} from './container-environment.js';
export type {
  ContainerDriver,
  ContainerExecConfig,
  ContainerSpawnConfig,
  ContainerStartConfig,
  ContainerVolumeMount,
  CreateContainerExecutionEnvironmentOptions,
} from './container-environment.js';

export {
  createRemoteExecutionEnvironment,
  createRemoteExecutionEnvironmentProvider,
  createDefaultRemoteTransport,
  remoteExecRequestSchema,
  remoteExecReplySchema,
  remoteSpawnRequestSchema,
} from './remote-environment.js';
export type {
  RemoteTransport,
  RemoteSpawnStream,
  RemoteExecRequest,
  RemoteExecReply,
  RemoteSpawnRequest,
  CreateRemoteExecutionEnvironmentOptions,
} from './remote-environment.js';

// Polling / pull-based execution — for executor hosts behind firewalls.
// The worker enqueues; the executor host polls outbound. No inbound
// connectivity required from the executor host side.
export {
  createPollingExecutionEnvironment,
  createPollingExecutionEnvironmentProvider,
  InMemoryPullingTaskQueue,
  PollingExecutorAgent,
  pullingTaskRequestSchema,
  pullingTaskResultSchema,
} from './polling-environment.js';
export type {
  CreatePollingExecutionEnvironmentOptions,
  PollingExecutorAgentOptions,
  PullingTaskQueue,
  PullingTaskRequest,
  PullingTaskResult,
  PullingTaskSource,
} from './polling-environment.js';

// Zod schema for SDK config namespace
export { toolsCommonNamespaceSchema } from './schema.js';
export type { ToolsCommonNamespaceConfig } from './schema.js';
