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

import type { SafeNamespaceConfig as SafeSchemaType } from '@berry-agent/safe';
import type { ToolsCommonNamespaceConfig as ToolsCommonSchemaType } from '@berry-agent/tools-common';
import type { ObserveNamespaceConfig as ObserveSchemaType } from '@berry-agent/observe';
export type { BerrySdkConfig } from './schema.js';

// Re-export namespace types for convenience (so consumers can
// `import { SafeNamespaceConfig } from '@berry-agent/config'` if desired).
export type { SafeSchemaType as SafeNamespaceConfig };
export type { ToolsCommonSchemaType as ToolsCommonNamespaceConfig };
export type { ObserveSchemaType as ObserveNamespaceConfig };
