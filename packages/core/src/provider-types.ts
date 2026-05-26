import type { SystemPromptBlock } from '@berry-agent/small-shared-core';
import type { ContentBlock, Message } from './content-types.js';
import type { ToolDefinition } from './tool-types.js';

export type ProviderType = 'anthropic' | 'openai';

export interface ProviderConfig {
  type: ProviderType;
  baseUrl?: string;
  apiKey: string;
  model: string;
  maxTokens?: number;
  /** Anthropic extended thinking budget; 0 means disabled. */
  thinkingBudget?: number;
  /**
   * Unified reasoning effort level.
   * Anthropic maps it to thinking budget, OpenAI maps it to reasoning_effort.
   */
  reasoningEffort?: 'none' | 'low' | 'medium' | 'high' | 'max' | 'xhigh';
}

export type ProviderPublicConfig = Omit<ProviderConfig, 'apiKey'> & {
  /** True when a secret is configured, without exposing the secret value. */
  apiKeyConfigured: boolean;
};

export function providerPublicConfig(config: ProviderConfig): ProviderPublicConfig {
  const { apiKey: _apiKey, ...rest } = config;
  return {
    ...rest,
    apiKeyConfigured: config.apiKey.trim().length > 0,
  };
}

/**
 * Pluggable provider resolver. Core owns when to ask for a provider config
 * and when to report failures; host packages own failover policy.
 */
export interface ProviderResolver {
  /** Unique id for logging. */
  readonly id: string;
  /** Return the provider config to use for the next request. */
  resolve(): ProviderConfig;
  /**
   * Report a failed provider call. Return true when the resolver switched to
   * another provider and the caller should immediately retry the same request.
   */
  reportError?(err: unknown, hints?: { isTransient?: boolean; statusCode?: number }): boolean | void;
  /** Reset any per-session resolver state. */
  resetForSession?(): void;
}

/** Input accepted by Agent.provider / AgentCreateConfig.provider. */
export type ProviderInput = ProviderConfig | ProviderResolver;

/**
 * Product-supplied model reference resolver. Core persists model refs as
 * strings in agent.json; host packages decide how refs map to providers.
 */
export type ModelRefResolver = (modelRef: string) => ProviderInput;

/** Narrow ProviderInput into ProviderResolver form, including static configs. */
export function toProviderResolver(input: ProviderInput): ProviderResolver {
  if ('resolve' in input && typeof (input as ProviderResolver).resolve === 'function') {
    return input as ProviderResolver;
  }
  const cfg = input as ProviderConfig;
  return {
    id: `static:${cfg.type}:${cfg.model}`,
    resolve: () => cfg,
  };
}

/** JSON Schema for structured output. */
export interface JsonSchema {
  name: string;
  description?: string;
  schema: Record<string, unknown>;
}

export interface ProviderRequest {
  /** System prompt blocks, split for cache optimization. */
  systemPrompt: SystemPromptBlock[];
  messages: Message[];
  tools?: ToolDefinition[];
  /** Abort signal. */
  signal?: AbortSignal;
  /** Force JSON schema output. */
  responseFormat?: JsonSchema;
}

export interface ProviderResponse {
  content: ContentBlock[];
  stopReason: 'end_turn' | 'tool_use' | 'max_tokens';
  usage: TokenUsage;
  rawUsage?: Record<string, unknown>;
  /** Provider-side wire format request for observe/debugging. */
  rawRequest?: Record<string, unknown>;
  /** Provider-side wire format response for observe/debugging. */
  rawResponse?: Record<string, unknown>;
}

/**
 * Unified token usage across providers.
 *
 * Semantic contract:
 * - `inputTokens` is the total input tokens this call billed against the
 *   context window, including cached portions.
 * - `cacheReadTokens` / `cacheWriteTokens` are cost analytics subsets of
 *   `inputTokens`; they are not additive with it.
 */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens?: number;
  cacheReadTokens?: number;
}

export interface Provider {
  readonly type: ProviderType;
  chat(request: ProviderRequest): Promise<ProviderResponse>;
  stream?(request: ProviderRequest): AsyncIterable<ProviderStreamEvent>;
}

export type ProviderStreamEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_delta'; thinking: string }
  | { type: 'response'; response: ProviderResponse };
