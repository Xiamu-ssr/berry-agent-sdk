// ============================================================
// Berry Agent SDK — Safe Package Types
// ============================================================

import type { ToolGuard, ToolGuardDecision, Provider, ProviderConfig } from '@berry-agent/core';

// ===== Guard types =====

/** A simple sync predicate for rule-based guards. */
export type GuardRule = (toolName: string, input: Record<string, unknown>) => ToolGuardDecision | null;

// ===== Classifier types =====

/** Configuration for the LLM transcript classifier. */
export interface ClassifierConfig {
  /** Provider config for the classifier model. Default model: claude-sonnet-4-20250514 */
  provider: ProviderConfig;
  /** Optional pre-built Provider instance (for sharing / testing). */
  providerInstance?: Provider;
  /** Trust boundary: domains, orgs, buckets that count as "internal". */
  environment?: EnvironmentConfig;
  /** Block rules. Uses defaultBlockRules if not specified. */
  blockRules?: string[];
  /** Allow exceptions. Uses defaultAllowExceptions if not specified. */
  allowExceptions?: string[];
  /** Skip Stage 2 reasoning (faster but higher FPR). Default: false */
  skipStage2?: boolean;
  /** Max consecutive denials before hard stop. Default: 3 */
  maxConsecutiveDenials?: number;
  /** Max total denials before hard stop. Default: 20 */
  maxTotalDenials?: number;
}

export interface EnvironmentConfig {
  /** Trusted domains (e.g. ['github.com/myorg', '*.internal.com']) */
  trustedDomains?: string[];
  /** Trusted cloud buckets (e.g. ['s3://my-bucket']) */
  trustedBuckets?: string[];
  /** Current git repo path (auto-trusted). */
  projectDir?: string;
}

/** What the classifier sees: stripped transcript. */
export interface ClassifierTranscript {
  /** User messages only (no assistant text). */
  userMessages: string[];
  /** Tool call payloads only (name + input, no results). */
  toolCalls: Array<{ name: string; input: Record<string, unknown> }>;
  /** The current tool call being evaluated. */
  currentAction: { name: string; input: Record<string, unknown> };
}

/** Classifier decision. */
export interface ClassifierDecision {
  action: 'allow' | 'deny';
  reason?: string;
  stage: 1 | 2;
  /** Tokens used by the classifier call. */
  classifierTokens?: number;
}

// ===== PI Probe types =====

export interface ProbeResult {
  safe: boolean;
  warning?: string;
  patterns?: string[];
}

// ===== Audit types =====

export interface AuditEntry {
  timestamp: number;
  toolName: string;
  input: Record<string, unknown>;
  decision: 'allow' | 'deny' | 'modify';
  reason?: string;
  guardType: 'rule' | 'classifier-stage1' | 'classifier-stage2' | 'probe';
  latencyMs: number;
}

export type AuditSink = (entry: AuditEntry) => void | Promise<void>;

// ===== Backpressure state =====

export interface BackpressureState {
  consecutiveDenials: number;
  totalDenials: number;
}
