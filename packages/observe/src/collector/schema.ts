// ============================================================
// Berry Agent SDK — Observe: Drizzle Schema
// ============================================================

import { sqliteTable, text, integer, real } from 'drizzle-orm/sqlite-core';

// ----- sessions -----

export const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey(),
  agentId: text('agent_id'),  // NEW: agent dimension
  startTime: integer('start_time').notNull(),
  endTime: integer('end_time'),
  totalCost: real('total_cost').notNull().default(0),
  status: text('status', { enum: ['active', 'completed', 'error'] }).notNull(),
});

// ----- turns ----- NEW: one user message → full agent loop → final response

export const turns = sqliteTable('turns', {
  id: text('id').primaryKey(),
  sessionId: text('session_id').notNull().references(() => sessions.id),
  agentId: text('agent_id'),
  prompt: text('prompt'),          // user message (truncated to 500 chars)
  startTime: integer('start_time').notNull(),
  endTime: integer('end_time'),
  llmCallCount: integer('llm_call_count').notNull().default(0),
  toolCallCount: integer('tool_call_count').notNull().default(0),
  totalCost: real('total_cost').notNull().default(0),
  status: text('status', { enum: ['active', 'completed', 'error'] }).notNull(),
});

// ----- llm_calls -----

export const llmCalls = sqliteTable('llm_calls', {
  id: text('id').primaryKey(),
  sessionId: text('session_id').notNull().references(() => sessions.id),
  agentId: text('agent_id'),  // NEW: denormalized for fast agent-level queries
  turnId: text('turn_id'),    // NEW: links to turns table (query_start → query_end)
  provider: text('provider').notNull(),
  model: text('model').notNull(),
  inputTokens: integer('input_tokens').notNull(),
  outputTokens: integer('output_tokens').notNull(),
  cacheReadTokens: integer('cache_read_tokens').notNull().default(0),
  cacheWriteTokens: integer('cache_write_tokens').notNull().default(0),
  inputCost: real('input_cost').notNull(),
  outputCost: real('output_cost').notNull(),
  cacheSavings: real('cache_savings').notNull(),
  totalCost: real('total_cost').notNull(),
  latencyMs: integer('latency_ms').notNull(),
  ttftMs: integer('ttft_ms'),
  stopReason: text('stop_reason').notNull(),
  messageCount: integer('message_count').notNull(),
  toolDefCount: integer('tool_def_count').notNull(),
  systemBlockCount: integer('system_block_count').notNull(),
  hasImages: integer('has_images', { mode: 'boolean' }).notNull(),
  skillsLoaded: text('skills_loaded'),
  providerDetail: text('provider_detail'),
  // full request/response content for inference replay
  requestSystem: text('request_system'),      // JSON: system prompt blocks
  requestMessages: text('request_messages'),  // JSON: Berry-format messages
  requestTools: text('request_tools'),        // JSON: tool definitions
  responseContent: text('response_content'),  // JSON: response content blocks
  providerRequest: text('provider_request'),  // JSON: wire-format request (Anthropic/OpenAI)
  providerResponse: text('provider_response'), // JSON: wire-format response
  timestamp: integer('timestamp').notNull(),
});

// ----- tool_calls -----

export const toolCalls = sqliteTable('tool_calls', {
  id: text('id').primaryKey(),
  sessionId: text('session_id').notNull().references(() => sessions.id),
  llmCallId: text('llm_call_id').references(() => llmCalls.id),
  turnId: text('turn_id'),  // NEW: links to turns table
  name: text('name').notNull(),
  input: text('input').notNull(),
  output: text('output').notNull(),
  isError: integer('is_error', { mode: 'boolean' }).notNull(),
  durationMs: integer('duration_ms').notNull(),
  timestamp: integer('timestamp').notNull(),
});

// ----- guard_decisions -----

export const guardDecisions = sqliteTable('guard_decisions', {
  id: text('id').primaryKey(),
  sessionId: text('session_id').notNull().references(() => sessions.id),
  llmCallId: text('llm_call_id').references(() => llmCalls.id),
  turnId: text('turn_id'),  // NEW: links to turns table
  toolName: text('tool_name').notNull(),
  input: text('input').notNull(),            // JSON: original tool input
  decision: text('decision').notNull(),      // 'allow' | 'deny' | 'modify'
  reason: text('reason'),                    // deny reason
  modifiedInput: text('modified_input'),     // JSON: modified input (if modify)
  callIndex: integer('call_index').notNull(),
  durationMs: integer('duration_ms').notNull(),
  timestamp: integer('timestamp').notNull(),
});

// ----- compaction_events -----

export const compactionEvents = sqliteTable('compaction_events', {
  id: text('id').primaryKey(),
  sessionId: text('session_id').notNull().references(() => sessions.id),
  triggerReason: text('trigger_reason').notNull(), // 'threshold' | 'overflow_retry'
  contextBefore: integer('context_before').notNull(),
  contextAfter: integer('context_after').notNull(),
  thresholdPct: real('threshold_pct').notNull(),
  contextWindow: integer('context_window').notNull(),
  layersApplied: text('layers_applied').notNull(), // JSON array
  durationMs: integer('duration_ms').notNull(),
  tokensFreed: integer('tokens_freed').notNull(),
  timestamp: integer('timestamp').notNull(),
});

// ----- agent_events -----

export const agentEvents = sqliteTable('agent_events', {
  id: text('id').primaryKey(),
  sessionId: text('session_id').notNull().references(() => sessions.id),
  kind: text('kind').notNull(),
  detail: text('detail'),
  timestamp: integer('timestamp').notNull(),
});
