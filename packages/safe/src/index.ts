// ============================================================
// @berry-agent/safe — Safety guards, classifier, audit, and sandbox
// ============================================================

// Tier 0: Pre-built rule guards (zero LLM cost)
export {
  denyList,
  allowList,
  directoryScope,
  rateLimiter,
  compositeGuard,
  writeScopeGuard,
} from './guards/rules.js';

// Tier 1: Human-in-the-loop approval (pauses on listed tools)
export { askList } from './guards/ask-list.js';
export type {
  AskBridge,
  AskQuestion,
  AskAnswer,
  AskListOptions,
} from './guards/ask-list.js';

// Tier 2: LLM Transcript Classifier (reasoning-blind, two-stage)
export {
  createClassifierGuard,
  defaultBlockRules,
  defaultAllowExceptions,
} from './classifier/transcript-classifier.js';

// Transcript builder (for advanced use / custom classifiers)
export {
  buildClassifierTranscript,
  formatTranscriptForClassifier,
} from './classifier/transcript-builder.js';

// Prompt Injection Probe (input layer)
export {
  scanForInjection,
  createPIProbeMiddleware,
} from './probe/pi-probe.js';

// Audit
export {
  withAudit,
  createMemoryAuditSink,
  createConsoleAuditSink,
} from './audit/audit-logger.js';

// Tier -1: OS-level sandbox (Seatbelt / bubblewrap)
export {
  createSandbox,
  createSandboxedExecutor,
  buildSandboxProfile,
  defaultSandboxConfig,
} from './sandbox/index.js';

// Types
export type {
  ClassifierConfig,
  ClassifierDecision,
  ClassifierTranscript,
  EnvironmentConfig,
  ProbeResult,
  AuditEntry,
  AuditSink,
  BackpressureState,
} from './types.js';

export type { SandboxConfig, SandboxProfile } from './sandbox/index.js';

// Zod schema for SDK config namespace
export { safeNamespaceSchema } from './schema.js';
export type { SafeNamespaceConfig } from './schema.js';

// SDK config integration
export { classifierConfigFromSdk } from './from-sdk-config.js';
