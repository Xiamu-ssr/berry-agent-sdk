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
import { sessions, turns, llmCalls, toolCalls, agentEvents, guardDecisions, compactionEvents } from './schema.js';
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
 * Create a unified collector that returns both middleware and event listener
 * sharing internal state (turnId, sessionId, lastLlmCallId).
 *
 * This is the preferred factory over createMiddleware + createEventListener separately.
 */
export function createCollector(config: CollectorConfig): {
  middleware: Middleware;
  eventListener: (event: AgentEvent) => void;
} {
  const { db } = config;
  const storeFull = config.storeFullContent !== false;

  // ===== Shared mutable state =====
  let currentSessionId: string | undefined;
  let currentTurnId: string | undefined;
  let lastLlmCallId: string | undefined;

  // ===== Middleware-internal state =====
  const pendingApiCalls = new Map<string, PendingApiCall>();
  const pendingToolCalls = new Map<string, PendingToolCall>();
  const toolInputKeyMap = new WeakMap<Record<string, unknown>, string>();

  // ===== Middleware =====
  const middleware: Middleware = {
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
        turnId: currentTurnId ?? null,
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

      // Update turn totals if we have a current turn
      if (currentTurnId) {
        db.db.update(turns)
          .set({
            llmCallCount: sql`${turns.llmCallCount} + 1`,
            totalCost: sql`${turns.totalCost} + ${cost.totalCost}`,
          })
          .where(eq(turns.id, currentTurnId))
          .run();
      }
    },

    onBeforeToolExec(
      toolName: string,
      input: Record<string, unknown>,
      context: MiddlewareContext,
    ): Record<string, unknown> {
      const key = `${context.sessionId}:${toolName}:${Date.now()}`;
      pendingToolCalls.set(key, { startTime: Date.now(), name: toolName });
      toolInputKeyMap.set(input, key);
      return input;
    },

    onAfterToolExec(
      toolName: string,
      input: Record<string, unknown>,
      result: ToolResult,
      context: MiddlewareContext,
    ): void {
      const key = toolInputKeyMap.get(input);
      toolInputKeyMap.delete(input);
      let durationMs = 0;
      if (key) {
        const pending = pendingToolCalls.get(key);
        pendingToolCalls.delete(key);
        durationMs = pending ? Date.now() - pending.startTime : 0;
      }

      const output = result.content.length > MAX_OUTPUT_LENGTH
        ? result.content.slice(0, MAX_OUTPUT_LENGTH) + '...'
        : result.content;

      db.db.insert(toolCalls).values({
        id: nanoid(),
        sessionId: context.sessionId,
        llmCallId: lastLlmCallId ?? null,
        turnId: currentTurnId ?? null,
        name: toolName,
        input: JSON.stringify(input),
        output,
        isError: result.isError ?? false,
        durationMs,
        timestamp: Date.now(),
      }).run();

      // Update turn tool call count
      if (currentTurnId) {
        db.db.update(turns)
          .set({ toolCallCount: sql`${turns.toolCallCount} + 1` })
          .where(eq(turns.id, currentTurnId))
          .run();
      }
    },
  };

  // ===== Event Listener =====
  const eventListener = (event: AgentEvent): void => {
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

        // Create a new turn for this query
        const turnId = nanoid();
        currentTurnId = turnId;
        db.db.insert(turns).values({
          id: turnId,
          sessionId: event.sessionId,
          agentId: config.agentId ?? null,
          prompt: event.prompt ? event.prompt.slice(0, 500) : null,
          startTime: Date.now(),
          endTime: null,
          llmCallCount: 0,
          toolCallCount: 0,
          totalCost: 0,
          status: 'active',
        }).run();

        db.db.insert(agentEvents).values({
          id: nanoid(),
          sessionId: event.sessionId,
          kind: 'query_start',
          detail: JSON.stringify({ prompt: event.prompt ? event.prompt.slice(0, 500) : null, turnId }),
          timestamp: Date.now(),
        }).run();
        break;
      }

      case 'api_response': {
        // Track last LLM call ID for guard/tool correlation
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
          turnId: currentTurnId ?? null,
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
        const sessionId = event.result.sessionId;

        db.db.insert(agentEvents).values({
          id: nanoid(),
          sessionId,
          kind: 'query_end',
          detail: JSON.stringify({
            toolCalls: event.result.toolCalls,
            compacted: event.result.compacted,
            turnId: currentTurnId,
          }),
          timestamp: Date.now(),
        }).run();

        // Finalize the current turn
        if (currentTurnId) {
          db.db.update(turns)
            .set({ status: 'completed', endTime: Date.now() })
            .where(eq(turns.id, currentTurnId))
            .run();
          currentTurnId = undefined;
        }

        // Update session status
        db.db.update(sessions)
          .set({ status: 'completed', endTime: Date.now() })
          .where(eq(sessions.id, sessionId))
          .run();

        currentSessionId = sessionId; // keep for reference
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

  return { middleware, eventListener };
}

/**
 * Create a middleware that collects LLM call and tool call data.
 * @deprecated Prefer createCollector() which shares state with the event listener.
 */
export function createMiddleware(config: CollectorConfig): Middleware {
  return createCollector(config).middleware;
}

/**
 * Create an event listener that records agent events, guard decisions,
 * compaction events, and manages session lifecycle.
 * @deprecated Prefer createCollector() which shares state with the middleware.
 */
export function createEventListener(config: CollectorConfig): (event: AgentEvent) => void {
  return createCollector(config).eventListener;
}
