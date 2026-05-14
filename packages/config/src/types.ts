// ============================================================
// @berry-agent/config — SDK Config Shape
// ============================================================
//
// `BerrySdkConfig` is the on-disk shape of the single JSON file that hosts
// hand to the SDK at startup. It is the source of truth for every piece of
// configuration that is inherently **process-wide**:
//
//   - Provider credentials, model bindings, tier mappings (required)
//   - Safety classifier defaults (optional)
//   - Tools-common defaults (optional)
//   - Observe defaults (optional)
//
// Per-agent concerns (system prompt, tool denylist, memory backend, etc.)
// live in each agent's workspace `agent.json` — NOT here.
//
// Extensibility rule: new top-level fields MUST be optional so older config
// files keep loading. The loader rejects unknown fields to surface typos.

import type { ModelsRegistry } from '@berry-agent/models';
import type { SafeNamespaceConfig as SafeSchemaType } from '@berry-agent/safe';
import type { ToolsCommonNamespaceConfig as ToolsCommonSchemaType } from '@berry-agent/tools-common';
import type { ObserveNamespaceConfig as ObserveSchemaType } from '@berry-agent/observe';

/**
 * Root config shape. `models` is required; all other namespaces
 * are optional and default to empty when absent.
 */
export interface BerrySdkConfig {
  /**
   * Provider instances, model bindings, and tier mapping. Required.
   *
   * The loader verifies every `ModelProviderRef.providerId` resolves and
   * every `tiers[tier]` points at a real binding — the Agent never sees
   * a dangling reference.
   */
  models: ModelsRegistry;
  /** Safety classifier defaults. When present, `safe.classifier.model` is
   *  used by `@berry-agent/safe` to auto-configure the classifier guard. */
  safe?: SafeSchemaType;
  /** Tools-common defaults (API keys, trusted domains, etc.). */
  'tools-common'?: ToolsCommonSchemaType;
  /** Observe defaults (DB path, retention, etc.). */
  observe?: ObserveSchemaType;
}

// Re-export namespace types for convenience (so consumers can
// `import { SafeNamespaceConfig } from '@berry-agent/config'` if desired).
export type { SafeSchemaType as SafeNamespaceConfig };
export type { ToolsCommonSchemaType as ToolsCommonNamespaceConfig };
export type { ObserveSchemaType as ObserveNamespaceConfig };
