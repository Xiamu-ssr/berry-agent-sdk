// ============================================================
// Agent runtime context assembly
// ============================================================

import { readFile } from 'node:fs/promises';
import {
  SystemPromptCacheMode,
  type SystemPromptBlock,
  type SystemPromptInput,
  normalizeSystemPrompt,
} from '@berry-agent/small-shared-core';

import { createRuntimeTools, type SleepSignal } from './runtime-tools.js';
import type { AgentEvent } from '../agent-runtime-types.js';
import type { Session } from '../session-types.js';
import type { ToolRegistration } from '../tool-types.js';
import type { ProjectContext } from '../workspace/types.js';
import { mergeToolsByName } from './messages.js';

export interface AgentSystemPromptDeps {
  projectContext: () => ProjectContext | undefined;
  agentMdPath: string;
  renderSkillIndexBlock: () => Promise<string | null>;
}

export async function buildAgentSystemPrompt(
  deps: AgentSystemPromptDeps,
  basePrompt: readonly SystemPromptBlock[],
  override?: SystemPromptInput,
): Promise<SystemPromptBlock[]> {
  if (override !== undefined) return normalizeSystemPrompt(override);

  const base = normalizeSystemPrompt(basePrompt);
  await appendProjectContext(base, deps.projectContext());
  await appendAgentInstructions(base, deps.agentMdPath);
  await appendSkillIndex(base, deps.renderSkillIndexBlock);
  return base;
}

export interface AgentToolResolverDeps {
  registeredTools: () => Iterable<ToolRegistration>;
  toolDenylist: () => ReadonlySet<string>;
  createSleepSignal: () => SleepSignal;
  emit: (event: AgentEvent) => void;
}

export function resolveAgentTools(
  deps: AgentToolResolverDeps,
  allowed?: string[],
  session?: Session,
): ToolRegistration[] {
  const runtime = createRuntimeTools({
    session,
    sleepSignal: deps.createSleepSignal(),
    onTodoChange: (s, state) => {
      deps.emit({
        type: 'todo_updated',
        sessionId: s.id,
        todos: state.items,
        timestamp: state.updatedAt,
      });
    },
  });
  const merged = mergeToolsByName([...deps.registeredTools()], runtime);
  const runtimeNames = new Set(runtime.map(t => t.definition.name));
  const allowedSet = allowed ? new Set(allowed) : null;

  const afterAllow = allowedSet
    ? merged.filter(tool => runtimeNames.has(tool.definition.name) || allowedSet.has(tool.definition.name))
    : merged;

  const denylist = deps.toolDenylist();
  return denylist.size > 0
    ? afterAllow.filter(tool => !denylist.has(tool.definition.name))
    : afterAllow;
}

async function appendProjectContext(base: SystemPromptBlock[], projectContext?: ProjectContext): Promise<void> {
  if (!projectContext) return;
  const context = await projectContext.loadContext();
  if (context) {
    base.push({ text: context, cache: SystemPromptCacheMode.Stable });
  }
}

async function appendAgentInstructions(base: SystemPromptBlock[], agentMdPath: string): Promise<void> {
  try {
    const agentMd = await readFile(agentMdPath, 'utf-8');
    if (agentMd.trim()) {
      base.push({ text: agentMd, cache: SystemPromptCacheMode.Stable });
    }
  } catch {
    // Missing or unreadable instructions should not break the agent loop.
  }
}

async function appendSkillIndex(
  base: SystemPromptBlock[],
  renderSkillIndexBlock: () => Promise<string | null>,
): Promise<void> {
  const index = await renderSkillIndexBlock();
  if (index) {
    base.push({ text: index, cache: SystemPromptCacheMode.Dynamic });
  }
}
