// ============================================================
// Berry Agent SDK — Common Tools: Public API
// ============================================================
//
// Usage:
//   import { createFileTools, createShellTool, createShellTools, createSearchTools, createAllTools } from '@berry-agent/tools-common';
//
//   const agent = Agent.create({
//     tools: createAllTools('/my/workspace'),
//     ...
//   });

import type { ToolRegistration } from '@berry-agent/core';
import { createFileTools } from './file.js';
import { createShellTool, createShellTools, type ShellToolOptions } from './shell.js';
import { createSearchTools } from './search.js';
import { createEditFileTool } from './edit.js';

export { createFileTools } from './file.js';
export { createShellTool, createShellTools } from './shell.js';
export type { ShellToolOptions } from './shell.js';
export { createSearchTools } from './search.js';
export { createEditFileTool } from './edit.js';
export { createWebFetchTool } from './web-fetch.js';
export { createWebSearchTool } from './web-search.js';
export type { SearchProvider, SearchResult, WebSearchConfig, TavilySearchConfig, BraveSearchConfig, SerpAPISearchConfig } from './web-search.js';
export { createBrowserTool } from './browser.js';
export type { BrowserAction, BrowserToolOptions } from './browser.js';

/**
 * Create all common tools (file + edit + shell + search) scoped to a directory.
 * Includes background process tools from createShellTools().
 * web_search, web_fetch, and browser are NOT included — use their factory functions separately.
 */
export function createAllTools(baseDir: string, shellOptions?: ShellToolOptions): ToolRegistration[] {
  return [
    ...createFileTools(baseDir),
    createEditFileTool(baseDir),
    ...createShellTools(baseDir, shellOptions),
    ...createSearchTools(baseDir),
  ];
}
