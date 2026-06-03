// ============================================================
// Agent introspection helpers
// ============================================================
// Read-only projections of Agent state. Extracted from agent.ts to
// keep the god class thin — introspection is a natural leaf because
// it only consumes state, never mutates it.

import type { SystemPromptBlock } from '@berry-agent/small-shared-core';
import { normalizeSystemPrompt } from '@berry-agent/small-shared-core';
import type { AgentStatus, Middleware } from '../agent-runtime-types.js';
import type { CompactionConfig, CompactionStrategy } from '../compaction/types.js';
import { providerPublicConfig, type ProviderConfig, type ProviderPublicConfig } from '../provider-types.js';
import type { ToolDefinition, ToolGuard, ToolRegistration } from '../tool-types.js';
import type { Hand } from '../hands.js';
import {
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_COMPACTION_RATIO,
  DEFAULT_SOFT_COMPACTION_RATIO,
} from '../constants.js';
import { getRuntimeToolDefinitions } from './runtime-tools.js';
import type { AgentMemory } from '../workspace/types.js';
import type { EventLogStore } from '../event-log/types.js';
import type { Skill } from '../skills/types.js';
import { mergeToolsByName } from './messages.js';

/** Minimal read-only view of Agent state that introspection helpers need. */
export interface IntrospectionDeps {
  readonly providerConfig: ProviderConfig;
  readonly systemPrompt: readonly SystemPromptBlock[];
  readonly tools: ReadonlyMap<string, ToolRegistration>;
  /** Live hand registry — lets the snapshot report hands as first-class
   *  (id/kind/displayName/capability count) rather than only the flattened
   *  tool list. Optional so callers that don't track hands still work. */
  readonly hands?: { list(): readonly Hand[] };
  readonly loadedSkills: readonly Skill[] | null;
  readonly cwd: string;
  readonly middleware: readonly Middleware[];
  readonly toolGuard?: ToolGuard;
  readonly workspaceRoot?: string;
  readonly memory?: AgentMemory;
  readonly compactionConfig?: CompactionConfig;
  readonly compactionStrategy?: CompactionStrategy;
  readonly eventLogStore?: EventLogStore;
  readonly status: AgentStatus;
  readonly statusDetail?: string;
}

/**
 * Per-MCP-server summary: upstream server name + the tool definitions
 * registered into the Agent from that server. Tool names remain prefixed
 * (`mcp__<server>__<tool>`) — the prefix is how they appear to the LLM.
 */
export interface MCPSummary {
  /** Upstream MCP server name (no prefix). */
  server: string;
  /** Tool definitions registered by this server (prefixed names). */
  tools: ToolDefinition[];
}

/**
 * Per-hand summary: a hand's identity + how many capabilities (tools) it
 * exposes. This is the 4+1-native view — an agent is a set of Hands, each a
 * bundle of capabilities bound to an execution surface. The flattened
 * `tools` list is the projection of all hands' capabilities for the model;
 * `hands` is the structural truth products should configure/show against.
 */
export interface HandSummary {
  id: string;
  kind: string;
  displayName?: string;
  /** Capability (tool) names this hand exposes. */
  capabilities: string[];
}

/**
 * A frozen-in-time view of agent configuration + runtime state. POJO —
 * safe to pass around, serialize, or diff. Produced by `agent.snapshot()`.
 */
export interface AgentSnapshot {
  provider: Readonly<ProviderPublicConfig>;
  systemPrompt: SystemPromptBlock[];
  tools: ToolDefinition[];
  /** Hands the agent has mounted (4+1-native; tools above is their projection). */
  hands: HandSummary[];
  mcp: MCPSummary[];
  skills: Array<{ name: string; description: string; dir: string }>;
  cwd: string;
  middleware: number;
  hasToolGuard: boolean;
  workspace?: string;
  memory?: { available: boolean };
  compaction?: {
    threshold: number;
    softThreshold: number;
    contextWindow: number;
    enabledLayers?: string[];
  };
  eventLog?: { available: boolean };
  hasCustomCompaction: boolean;
  status: AgentStatus;
  statusDetail?: string;
  /** Wall-clock ms at snapshot time. */
  capturedAt: number;
}

/** Lightweight skill meta projection (dir + name + description). */
export function getSkillMetasFrom(
  loadedSkills: readonly Skill[] | null,
): Array<{ name: string; description: string; dir: string }> {
  if (!loadedSkills) return [];
  return loadedSkills.map((s) => ({
    name: s.meta.name,
    description: s.meta.description,
    dir: s.dir,
  }));
}

/**
 * Merge registered tools with runtime tools (todo / sleep) to produce the
 * definition list shown via Agent.getTools().
 *
 * Runtime tools here use no-op executors because this path is definition-only.
 */
export function getToolsFrom(deps: IntrospectionDeps): ToolDefinition[] {
  const registered = [...deps.tools.values()];
  const runtime = getRuntimeToolDefinitions({
    sleepSignal: {
      onEnter: () => {},
      onExit: () => {},
      interjectWaker: () => new Promise(() => {}),
    },
  }).map((definition) => ({
    definition,
    execute: async () => ({ content: '' }),
  }));

  return mergeToolsByName(registered, runtime).map((t) => t.definition);
}

/**
 * Group MCP-sourced tools by upstream server. Pure projection of the tools
 * Map — MCP adapters stamp `source.kind === 'mcp'` when registering, and
 * this helper just rolls them up for `agent.getMCP()` / snapshots.
 */
export function getMCPFrom(deps: IntrospectionDeps): MCPSummary[] {
  const byServer = new Map<string, ToolDefinition[]>();
  for (const reg of deps.tools.values()) {
    if (reg.source?.kind !== 'mcp' || !reg.source.server) continue;
    const list = byServer.get(reg.source.server) ?? [];
    list.push(reg.definition);
    byServer.set(reg.source.server, list);
  }
  return [...byServer.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([server, tools]) => ({ server, tools }));
}

/** Hands the agent has mounted, as 4+1-native summaries. */
function getHandsFrom(deps: IntrospectionDeps): HandSummary[] {
  if (!deps.hands) return [];
  return deps.hands.list().map((hand: Hand) => ({
    id: hand.id,
    kind: hand.kind,
    displayName: hand.displayName,
    capabilities: hand.capabilities().map((c) => c.definition.name),
  }));
}

/** Full agent snapshot. Produced by `agent.snapshot()`. */
export function snapshotFrom(deps: IntrospectionDeps): AgentSnapshot {
  const ctxWindow = deps.compactionConfig?.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
  return {
    provider: providerPublicConfig(deps.providerConfig),
    systemPrompt: normalizeSystemPrompt(deps.systemPrompt),
    tools: getToolsFrom(deps),
    hands: getHandsFrom(deps),
    mcp: getMCPFrom(deps),
    skills: getSkillMetasFrom(deps.loadedSkills),
    cwd: deps.cwd,
    middleware: deps.middleware.length,
    hasToolGuard: !!deps.toolGuard,
    workspace: deps.workspaceRoot,
    memory: { available: !!deps.memory },
    compaction: {
      threshold:
        deps.compactionConfig?.threshold ??
        Math.floor(ctxWindow * DEFAULT_COMPACTION_RATIO),
      softThreshold:
        deps.compactionConfig?.softThreshold ??
        Math.floor(ctxWindow * DEFAULT_SOFT_COMPACTION_RATIO),
      contextWindow: ctxWindow,
      enabledLayers: deps.compactionConfig?.enabledLayers,
    },
    eventLog: { available: !!deps.eventLogStore },
    hasCustomCompaction: !!deps.compactionStrategy,
    status: deps.status,
    statusDetail: deps.statusDetail,
    capturedAt: Date.now(),
  };
}
