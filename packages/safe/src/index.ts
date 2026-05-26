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
export { DEFAULT_APPROVAL_TIMEOUT_MS } from './guards/ask-list.js';
export { ApprovalBroker } from './approval-broker.js';
export type { ApprovalBrokerOptions, PendingApproval } from './approval-broker.js';

// Tier 2: LLM Transcript Classifier (reasoning-blind, two-stage)
export {
  createClassifierGuard,
  defaultBlockRules,
  defaultAllowExceptions,
} from './classifier/transcript-classifier.js';
export {
  DEFAULT_CLASSIFIER_MODEL_REF,
  resolveClassifierConfig,
} from './classifier-config.js';
export type {
  ResolveClassifierConfigOptions,
  ResolvedClassifierConfig,
} from './classifier-config.js';

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

// Managed-agent safety composition
export {
  CATASTROPHIC_DENY_PATTERNS,
  DEFAULT_DANGEROUS_PATTERNS,
  DEFAULT_HITL_TOOLS,
  buildManagedToolGuard,
} from './managed-guard.js';
export type { ManagedClassifierOptions, ManagedToolGuardOptions } from './managed-guard.js';

// Project-level safety settings
export {
  SAFETY_LEVELS,
  asSafetyLevel,
  projectSafetyPath,
  readProjectSafety,
  resolveSafetyLevel,
  writeProjectSafety,
} from './project-safety.js';
export type { ProjectSafetyConfig, SafetyLevel } from './project-safety.js';

// Zod schema for SDK config namespace
export { safeNamespaceSchema } from './schema.js';
export type { SafeNamespaceConfig } from './schema.js';

// SDK config integration
export { classifierConfigFromSdk } from './from-sdk-config.js';
