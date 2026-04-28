// ============================================================
// Berry Agent SDK — Common Tools: Public API
// ============================================================
//
// Usage:
//   import { createFileTools, createShellTool, createShellTools, createSearchTools, createAllTools } from '@berry-agent/tools-common';
//
//   const agent = Agent.create({
//     tools: createAllTools('/my/project'),
//     ...
//   });

import type { ToolRegistration } from '@berry-agent/core';
import { AgentScope } from '@berry-agent/core';
import { createFileTools } from './file.js';
import { createShellTool, createShellTools, type ShellToolOptions } from './shell.js';
import { createSearchTools } from './search.js';
import { createEditFileTool } from './edit.js';

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
export { createBrowserTool } from './browser.js';
export type { BrowserAction, BrowserToolOptions } from './browser.js';

/**
 * Create all common tools (file + edit + shell + search) scoped to a project directory.
 *
 * Accepts either an AgentScope (preferred) or a project root string (backward compat).
 * When given a string, creates an AgentScope.fromRoot(projectRoot).
 *
 * Paths are resolved in Claude Code style:
 *   "/path"     → relative to projectDir
 *   "path"      → relative to cwd (from ToolContext)
 *   "//abs/path" → absolute path (must stay within scope)
 *
 * web_search, web_fetch, and browser are NOT included — use their factory functions separately.
 */
export function createAllTools(scopeOrRoot: AgentScope | string, shellOptions?: ShellToolOptions): ToolRegistration[] {
  const scope = typeof scopeOrRoot === 'string'
    ? new AgentScope(scopeOrRoot, scopeOrRoot)
    : scopeOrRoot;
  const projectDir = scope.projectDir;
  return [
    ...createFileTools(projectDir),
    createEditFileTool(projectDir),
    ...createShellTools(projectDir, shellOptions),
    ...createSearchTools(projectDir),
  ];
}
