// ============================================================
// Berry Agent SDK — Common Tools: Public API
// ============================================================
//
// Usage:
//   import { createLocalWorkspaceHand } from '@berry-agent/tools-common';
//
//   const agent = Agent.create({
//     hands: [createLocalWorkspaceHand({ scope, credentials })],
//     ...
//   });

export { createFileTools } from './file.js';
export { createShellTool, createShellTools } from './shell.js';
export type { ShellToolOptions } from './shell.js';
export { NodeExecutor } from './executor.js';
export type { CommandExecutor, ExecOptions, ExecResult, SpawnOptions, ProcessHandle } from '@berry-agent/core';
export { createSearchTools } from './search.js';
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

// Zod schema for SDK config namespace
export { toolsCommonNamespaceSchema } from './schema.js';
export type { ToolsCommonNamespaceConfig } from './schema.js';
