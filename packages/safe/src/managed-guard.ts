// ============================================================
// @berry-agent/safe - Managed agent safety guard
// ============================================================
// Opinionated guard composition for managed agents. Hosts can still choose
// the effective level and provide a HITL bridge, but the actual guard graph
// lives in the SDK safety package instead of being reimplemented by products.

import { errorMessage, type AgentScope, type ToolGuard } from '@berry-agent/core';
import type { ModelsRegistry } from '@berry-agent/models';
import { createClassifierGuard } from './classifier/transcript-classifier.js';
import { askList, type AskBridge } from './guards/ask-list.js';
import { compositeGuard, denyList, writeScopeGuard } from './guards/rules.js';
import type { SafetyLevel } from './project-safety.js';
import type { ClassifierConfig } from './types.js';

/** Absolute-floor denylist applied in every mode, including `trust`. */
export const CATASTROPHIC_DENY_PATTERNS = ['rm -rf /', 'rm -rf ~', 'DROP DATABASE'] as const;

/** Additional denies applied in `default` and `auto`. */
export const DEFAULT_DANGEROUS_PATTERNS = ['DROP TABLE'] as const;

/** Built-in side-effect surfaces that require HITL in `auto` mode. */
export const DEFAULT_HITL_TOOLS = [
  'shell',
  'write_file',
  'edit_file',
  'web_fetch',
] as const;

export interface ManagedClassifierOptions
  extends Pick<
    ClassifierConfig,
    | 'blockRules'
    | 'allowExceptions'
    | 'maxConsecutiveDenials'
    | 'maxTotalDenials'
  > {
  modelRef: string;
  registry: ModelsRegistry;
  projectDir?: string;
  skipStage2?: boolean;
  tools?: string[];
}

export interface ManagedToolGuardOptions {
  /** AgentScope is the single source of truth for writable paths. */
  scope: AgentScope;
  /** Host-provided human approval bridge. Omitted bridge fails closed. */
  askBridge?: AskBridge;
  /** Tool names that should go through HITL under `auto`. */
  hitlTools?: string[];
  /** Max ms to wait for a human response before auto-denying. */
  hitlTimeoutMs?: number;
  /** Agent id propagated to approval questions and durable audit events. */
  agentId?: string;
  /** Optional LLM classifier. When unavailable at call time, HITL is used. */
  classifier?: ManagedClassifierOptions;
}

/**
 * Build the standard managed-agent ToolGuard chain.
 *
 * Shape per mode:
 * - `trust`: catastrophic denylist only
 * - `default`: write scope guard + denylist
 * - `auto`: default + classifier with HITL fallback, or HITL directly
 */
export function buildManagedToolGuard(
  level: SafetyLevel,
  opts: ManagedToolGuardOptions,
): ToolGuard {
  const { scope, askBridge, hitlTools, hitlTimeoutMs, classifier } = opts;
  const floorDenies = denyList([...CATASTROPHIC_DENY_PATTERNS]);

  if (level === 'trust') {
    return floorDenies;
  }

  const write = writeScopeGuard(scope);
  const broadDenies = denyList([...CATASTROPHIC_DENY_PATTERNS, ...DEFAULT_DANGEROUS_PATTERNS]);

  if (level === 'default') {
    return compositeGuard(write, broadDenies);
  }

  const hitl = askList({
    tools: [...(hitlTools ?? DEFAULT_HITL_TOOLS)],
    ask: askBridge,
    agentId: opts.agentId,
    timeoutMs: hitlTimeoutMs,
    reason: 'Human approval required (safety mode: auto)',
  });

  if (!classifier) {
    return compositeGuard(write, broadDenies, hitl);
  }

  const classifierGuard = createClassifierGuard({
    modelRef: classifier.modelRef,
    registry: classifier.registry,
    environment: { projectDir: classifier.projectDir ?? scope.projectDir },
    skipStage2: classifier.skipStage2,
    blockRules: classifier.blockRules,
    allowExceptions: classifier.allowExceptions,
    maxConsecutiveDenials: classifier.maxConsecutiveDenials,
    maxTotalDenials: classifier.maxTotalDenials,
  });
  const guardedClassifier = withHitlFallback(
    filterGuardByTool(classifierGuard, classifier.tools),
    filterGuardByTool(hitl, classifier.tools),
  );
  return compositeGuard(write, broadDenies, guardedClassifier);
}

function filterGuardByTool(guard: ToolGuard, tools?: string[]): ToolGuard {
  if (!tools?.length) return guard;
  const selected = new Set(tools);
  return async (ctx) => selected.has(ctx.toolName) ? guard(ctx) : { action: 'allow' };
}

function withHitlFallback(primary: ToolGuard, fallback: ToolGuard): ToolGuard {
  return async (ctx) => {
    try {
      return await primary(ctx);
    } catch (err) {
      console.warn(
        `[safety] classifier unavailable for ${ctx.toolName}; falling back to HITL:`,
        errorMessage(err),
      );
      return fallback(ctx);
    }
  };
}
