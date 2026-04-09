// ============================================================
// @berry-agent/safe — Safety guards, classifier, and audit
// ============================================================

// Tier 0: Pre-built rule guards (zero LLM cost)
export {
  denyList,
  allowList,
  directoryScope,
  rateLimiter,
  compositeGuard,
} from './guards/rules.js';

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
