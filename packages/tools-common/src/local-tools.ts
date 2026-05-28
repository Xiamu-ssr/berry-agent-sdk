import { type AgentScope, type ToolRegistration } from '@berry-agent/core';
import { createEditFileTool } from './edit.js';
import { createFileTools } from './file.js';
import { createSearchTools } from './search.js';
import { createShellTools, type ShellToolOptions } from './shell.js';

export function createLocalToolRegistrations(
  scope: AgentScope,
  shellOptions?: ShellToolOptions,
): ToolRegistration[] {
  const projectDir = scope.projectDir;
  return [
    ...createFileTools(projectDir),
    createEditFileTool(projectDir),
    ...createShellTools(projectDir, shellOptions),
    // Share the executor with shell tools so sandboxing applies uniformly.
    ...createSearchTools(projectDir, { executor: shellOptions?.executor }),
  ];
}
