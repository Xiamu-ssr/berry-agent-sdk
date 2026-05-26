// ============================================================
// Berry Agent SDK — Workspace Initializer
// ============================================================
//
// `agent.json` is the **single source of truth** for all runtime-switchable
// Agent configuration (AGENTS.md §agent.json). The Agent constructor reads
// this file synchronously on startup; `switchModel()` /
// `addTool()` / `setToolDenylist()` write through to this file so a restart
// picks up the same state.
//
// Rules:
//   - No in-memory defaults override the on-disk values.
//   - `systemPrompt` is NOT in here (it lives in AGENTS.md).
//   - Read/write is synchronous and unbuffered — simplicity over throughput.

import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  renameSync,
} from 'node:fs';
import { basename } from 'node:path';
import { z } from 'zod';
import { AgentHome } from '../agent-home.js';
import type { CompactionConfig } from '../compaction/types.js';

export const zReasoningEffort = z.enum(['none', 'low', 'medium', 'high', 'max', 'xhigh']);
/** Reasoning effort levels supported by providers. */
export type ReasoningEffort = z.infer<typeof zReasoningEffort>;

/**
 * Agent metadata stored in agent.json. Everything here is runtime-switchable.
 *
 * The seed shape (first-time init) comes from the AgentConfig the product
 * passes to `new Agent()`; after that, this file is authoritative.
 */
export interface AgentMetadata {
  id: string;
  name: string;
  createdAt: string;
  /**
   * Model reference string resolved via the models registry.
   * Examples: "tier:strong", "model:claude-opus-4.7", "claude-sonnet-4-20250514".
   * `switchModel()` writes this. Credentials live in the SDK-level config,
   * NOT in agent.json.
   */
  model?: string;
  /** Reasoning effort level. `setReasoningEffort()` writes this. */
  reasoningEffort?: ReasoningEffort;
  /** Compaction tuning. `switchCompaction()` (if ever added) rewrites this. */
  compaction?: CompactionConfig;
  /** Skill pool discovery — directories scanned one level deep for `SKILL.md`. */
  skills?: { extraDirs?: string[] };
  /** MCP discovery — extra `.mcp.json` paths loaded in addition to `<root>/.mcp.json`. */
  mcp?: { extraPaths?: string[] };
  /** Tool denylist — names returned from ToolGuard as `deny` regardless of other logic. */
  toolDenylist?: string[];
  /** Free-form safety tier tag (product-defined). SDK does not interpret — products
   *  map this to a concrete ToolGuard. */
  safeLevel?: string;
}

/** Seed values used only on first-time init; ignored once agent.json exists. */
export interface InitWorkspaceSeed {
  /** Model reference string (e.g. "tier:strong") written on first init only. */
  model?: string;
  /** Reasoning effort for the initial model. */
  reasoningEffort?: ReasoningEffort;
  compaction?: CompactionConfig;
  skills?: { extraDirs?: string[] };
  mcp?: { extraPaths?: string[] };
  toolDenylist?: string[];
  safeLevel?: string;
}

const zCompactionLayer = z.enum([
  'clear_thinking',
  'truncate_tool_results',
  'clear_tool_pairs',
  'merge_messages',
  'summarize',
  'trim_assistant',
  'truncate_oldest',
]);

export const zAgentMetadata = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  createdAt: z.string().min(1),
  model: z.string().min(1).optional(),
  reasoningEffort: zReasoningEffort.optional(),
  compaction: z.object({
    threshold: z.number().optional(),
    softThreshold: z.number().optional(),
    contextWindow: z.number().optional(),
    enabledLayers: z.array(zCompactionLayer).optional(),
    softLayers: z.array(zCompactionLayer).optional(),
  }).strict().optional(),
  skills: z.object({
    extraDirs: z.array(z.string().min(1)).optional(),
  }).strict().optional(),
  mcp: z.object({
    extraPaths: z.array(z.string().min(1)).optional(),
  }).strict().optional(),
  toolDenylist: z.array(z.string().min(1)).optional(),
  safeLevel: z.string().min(1).optional(),
}).strict() satisfies z.ZodType<AgentMetadata>;

/**
 * Initialize an agent workspace directory (synchronous).
 *
 * Creates on first call:
 * ```
 * {root}/
 *   ├── agent.json      (full AgentMetadata)
 *   ├── AGENTS.md       (empty system prompt snippet)
 *   ├── MEMORY.md       (empty)
 *   └── sessions/
 *   └── skills/
 * ```
 *
 * Seed semantics:
 *   - File missing -> write a fresh metadata composed from seed.
 *   - File exists -> read agent.json as-is; no implicit migration/back-fill.
 */
export function initWorkspaceSync(root: string, seed?: InitWorkspaceSeed): AgentMetadata {
  const home = new AgentHome(root);
  const agentJsonPath = home.metadataPath;

  if (existsSync(agentJsonPath)) {
    return loadAgentConfigSync(root);
  }

  // Create directory structure
  mkdirSync(home.sessionsDir, { recursive: true });
  mkdirSync(home.skillsDir, { recursive: true });

  const id = slugify(basename(root));
  const metadata: AgentMetadata = {
    id,
    name: basename(root),
    createdAt: new Date().toISOString(),
    ...(seed?.model && { model: seed.model }),
    ...(seed?.reasoningEffort && { reasoningEffort: seed.reasoningEffort }),
    ...(seed?.compaction && { compaction: seed.compaction }),
    ...(seed?.skills && { skills: seed.skills }),
    ...(seed?.mcp && { mcp: seed.mcp }),
    ...(seed?.toolDenylist && { toolDenylist: seed.toolDenylist }),
    ...(seed?.safeLevel && { safeLevel: seed.safeLevel }),
  };

  writeJsonAtomicSync(agentJsonPath, zAgentMetadata.parse(metadata));
  // AGENTS.md and MEMORY.md are lazy — only created if written to.
  if (!existsSync(home.agentMdPath)) {
    writeFileSync(home.agentMdPath, '', 'utf-8');
  }
  if (!existsSync(home.memoryPath)) {
    writeFileSync(home.memoryPath, '', 'utf-8');
  }

  return metadata;
}

/** Async wrapper, kept for callers that happen to be in async context. */
export async function initWorkspace(root: string, seed?: InitWorkspaceSeed): Promise<AgentMetadata> {
  return initWorkspaceSync(root, seed);
}

/** Read `agent.json` synchronously. Throws if the file is missing or malformed. */
export function loadAgentConfigSync(root: string): AgentMetadata {
  const path = new AgentHome(root).metadataPath;
  const raw = readFileSync(path, 'utf-8');
  return parseAgentMetadata(raw, path);
}

/**
 * Merge-write `agent.json` synchronously. Existing fields survive unless the
 * patch explicitly overrides them. Used by `switchModel` et al.
 */
export function saveAgentConfigSync(root: string, patch: Partial<AgentMetadata>): AgentMetadata {
  const path = new AgentHome(root).metadataPath;
  const current = loadAgentConfigSync(root);
  const next = zAgentMetadata.parse({ ...current, ...patch });
  writeJsonAtomicSync(path, next);
  return next;
}

function parseAgentMetadata(raw: string, path: string): AgentMetadata {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Failed to parse agent metadata "${path}": ${err instanceof Error ? err.message : String(err)}`);
  }

  try {
    return zAgentMetadata.parse(parsed);
  } catch (err) {
    if (err instanceof z.ZodError) {
      throw new Error(`Invalid agent metadata "${path}": ${err.issues.map((issue) => issue.message).join('; ')}`);
    }
    throw err;
  }
}

function writeJsonAtomicSync(path: string, value: unknown): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf-8');
  renameSync(tmp, path);
}

/** Convert a directory name to a URL-friendly slug. */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    || 'agent';
}
