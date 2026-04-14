// ============================================================
// Berry Agent SDK — Observe: Collectors (Middleware + Event)
// ============================================================

import { nanoid } from 'nanoid';
import { eq, sql } from 'drizzle-orm';
import type {
  Middleware,
  MiddlewareContext,
  ProviderRequest,
  ProviderResponse,
  ToolResult,
  AgentEvent,
} from '@berry-agent/core';
import type { ObserveDB } from './db.js';
import { sessions, llmCalls, toolCalls, agentEvents, guardDecisions, compactionEvents } from './schema.js';
import { calculateCost, type ModelPricing } from './pricing.js';

const MAX_OUTPUT_LENGTH = 4096;
const MAX_JSON_FIELD = 512_000; // 500KB limit per JSON field to prevent DB bloat

function safeJsonStringify(value: unknown, maxLen = MAX_JSON_FIELD): string | null {
  if (value == null) return null;
  try {
    const json = JSON.stringify(value);
    return json.length > maxLen ? json.slice(0, maxLen) + '..."truncated"' : json;
  } catch {
    return null;
  }
}

interface PendingApiCall {
  startTime: number;
  request: ProviderRequest;
}

interface PendingToolCall {
  startTime: number;
  name: string;
}

export interface CollectorConfig {
  db: ObserveDB;
  pricingOverrides?: Record<string, ModelPricing>;
  /** Optional agent ID for multi-agent setups */
  agentId?: string;
  /** Whether to store full request/response bodies (default: true) */
  storeFullContent?: boolean;
}

/**
 * Create a middleware that collects LLM call and tool call data.
 */
export function createMiddleware(config: CollectorConfig): Middleware {
  const { db } = config;
  const storeFull = config.storeFullContent !== false;
  const pendingApiCalls = new Map<string, PendingApiCall>();
  const pendingToolCalls = new Map<string, PendingToolCall>();
  let lastLlmCallId: string | undefined;

  return {
    onBeforeApiCall(request: ProviderRequest, context: MiddlewareContext): ProviderRequest {
      pendingApiCalls.set(context.sessionId, {
        startTime: Date.now(),
        request: structuredClone(request),
      });
      return request;
    },

    onAfterApiCall(request: ProviderRequest, response: ProviderResponse, context: MiddlewareContext): void {
      const pending = pendingApiCalls.get(context.sessionId);
      pendingApiCalls.delete(context.sessionId);
      const startTime = pending?.startTime ?? Date.now();
      const latencyMs = Date.now() - startTime;

      const inputTokens = response.usage.inputTokens;
      const outputTokens = response.usage.outputTokens;
      const cacheReadTokens = response.usage.cacheReadTokens ?? 0;
      const cacheWriteTokens = response.usage.cacheWriteTokens ?? 0;

      const cost = calculateCost(
        context.model,
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheWriteTokens,
        config.pricingOverrides,
      );

      // Detect images in messages
      const hasImages = request.messages.some(
        (m) =>
          Array.isArray(m.content) &&
          m.content.some((b: any) => b.type === 'image'),
      );

      const id = nanoid();
      lastLlmCallId = id;

      db.db.insert(llmCalls).values({
        id,
        sessionId: context.sessionId,
        agentId: config.agentId ?? null,
        provider: context.provider,
        model: context.model,
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheWriteTokens,
        inputCost: cost.inputCost,
        outputCost: cost.outputCost,
        cacheSavings: cost.cacheSavings,
        totalCost: cost.totalCost,
        latencyMs,
        ttftMs: null,
        stopReason: response.stopReason,
        messageCount: request.messages.length,
        toolDefCount: request.tools?.length ?? 0,
        systemBlockCount: request.systemPrompt.length,
        hasImages,
        skillsLoaded: null,
        providerDetail: response.rawUsage ? JSON.stringify(response.rawUsage) : null,
        // Full content fields
        requestSystem: storeFull ? safeJsonStringify(request.systemPrompt) : null,
        requestMessages: storeFull ? safeJsonStringify(request.messages) : null,
        requestTools: storeFull ? safeJsonStringify(request.tools) : null,
        responseContent: storeFull ? safeJsonStringify(response.content) : null,
        providerRequest: storeFull ? safeJsonStringify(response.rawRequest) : null,
        providerResponse: storeFull ? safeJsonStringify(response.rawResponse) : null,
        timestamp: Date.now(),
      }).run();

      // Update session totalCost — atomic increment
      db.db.update(sessions)
        .set({ totalCost: sql`${sessions.totalCost} + ${cost.totalCost}` })
        .where(eq(sessions.id, context.sessionId))
        .run();
    },

    onBeforeToolExec(
      toolName: string,
      input: Record<string, unknown>,
      context: MiddlewareContext,
    ): Record<string, unknown> {
      const key = `${context.sessionId}:${toolName}:${Date.now()}`;
      pendingToolCalls.set(key, { startTime: Date.now(), name: toolName });
      // Stash the key for retrieval in onAfterToolExec
      (input as any).__observeKey = key;
      return input;
    },

    onAfterToolExec(
      toolName: string,
      input: Record<string, unknown>,
      result: ToolResult,
      context: MiddlewareContext,
    ): void {
      const key = (input as any).__observeKey as string | undefined;
      let durationMs = 0;
      if (key) {
        const pending = pendingToolCalls.get(key);
        pendingToolCalls.delete(key);
        durationMs = pending ? Date.now() - pending.startTime : 0;
        delete (input as any).__observeKey;
      }

      const output = result.content.length > MAX_OUTPUT_LENGTH
        ? result.content.slice(0, MAX_OUTPUT_LENGTH) + '...'
        : result.content;

      db.db.insert(toolCalls).values({
        id: nanoid(),
        sessionId: context.sessionId,
        llmCallId: lastLlmCallId ?? null,
        name: toolName,
        input: JSON.stringify(input),
        output,
        isError: result.isError ?? false,
        durationMs,
        timestamp: Date.now(),
      }).run();
    },
  };
}

/**
 * Create an event listener that records agent events, guard decisions,
 * compaction events, and manages session lifecycle.
 */
export function createEventListener(config: CollectorConfig): (event: AgentEvent) => void {
  const { db } = config;
  let currentSessionId: string | undefined;
  let lastLlmCallId: string | undefined;

  return (event: AgentEvent) => {
    switch (event.type) {
      case 'query_start': {
        currentSessionId = event.sessionId;
        // Ensure session exists
        const existing = db.db.select().from(sessions)
          .where(eq(sessions.id, event.sessionId)).get();
        if (!existing) {
          db.db.insert(sessions).values({
            id: event.sessionId,
            agentId: config.agentId ?? null,
            startTime: Date.now(),
            endTime: null,
            totalCost: 0,
            status: 'active',
          }).run();
        }

        db.db.insert(agentEvents).values({
          id: nanoid(),
          sessionId: event.sessionId,
          kind: 'query_start',
          detail: JSON.stringify({ prompt: event.prompt.slice(0, 500) }),
          timestamp: Date.now(),
        }).run();
        break;
      }

      case 'api_response': {
        // Track last LLM call ID for guard/tool correlation
        // Retrieve the most recent llm_call for this session
        if (currentSessionId) {
          const latest = db.db.select({ id: llmCalls.id })
            .from(llmCalls)
            .where(eq(llmCalls.sessionId, currentSessionId))
            .orderBy(sql`timestamp DESC`)
            .limit(1)
            .get();
          lastLlmCallId = latest?.id;
        }
        break;
      }

      case 'guard_decision': {
        if (!currentSessionId) break;
        db.db.insert(guardDecisions).values({
          id: nanoid(),
          sessionId: currentSessionId,
          llmCallId: lastLlmCallId ?? null,
          toolName: event.toolName,
          input: JSON.stringify(event.input),
          decision: event.decision.action,
          reason: event.decision.action === 'deny' ? (event.decision as any).reason ?? null : null,
          modifiedInput: event.decision.action === 'modify'
            ? JSON.stringify((event.decision as any).input)
            : null,
          callIndex: event.callIndex,
          durationMs: event.durationMs,
          timestamp: Date.now(),
        }).run();
        break;
      }

      case 'compaction': {
        if (!currentSessionId) break;
        db.db.insert(compactionEvents).values({
          id: nanoid(),
          sessionId: currentSessionId,
          triggerReason: event.triggerReason,
          contextBefore: event.contextBefore,
          contextAfter: event.contextAfter,
          thresholdPct: event.thresholdPct,
          contextWindow: event.contextWindow,
          layersApplied: JSON.stringify(event.layersApplied),
          durationMs: event.durationMs,
          tokensFreed: event.tokensFreed,
          timestamp: Date.now(),
        }).run();

        db.db.insert(agentEvents).values({
          id: nanoid(),
          sessionId: currentSessionId,
          kind: 'compaction',
          detail: JSON.stringify({
            triggerReason: event.triggerReason,
            layersApplied: event.layersApplied,
            tokensFreed: event.tokensFreed,
            contextBefore: event.contextBefore,
            contextAfter: event.contextAfter,
          }),
          timestamp: Date.now(),
        }).run();
        break;
      }

      case 'query_end': {
        db.db.insert(agentEvents).values({
          id: nanoid(),
          sessionId: event.result.sessionId,
          kind: 'query_end',
          detail: JSON.stringify({
            toolCalls: event.result.toolCalls,
            compacted: event.result.compacted,
          }),
          timestamp: Date.now(),
        }).run();

        // Update session status
        db.db.update(sessions)
          .set({ status: 'completed', endTime: Date.now() })
          .where(eq(sessions.id, event.result.sessionId))
          .run();

        currentSessionId = event.result.sessionId; // keep for reference
        break;
      }

      case 'delegate_start':
      case 'delegate_end':
      case 'child_spawned':
      case 'child_destroyed':
        // Future: track delegate/spawn chains
        break;

      default:
        break;
    }
  };
}
