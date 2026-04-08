// ============================================================
// Agentic SDK — Anthropic Provider
// ============================================================
// Wraps the official Anthropic SDK. Handles:
// - cache_control breakpoint placement
// - Message format conversion (Agentic → Anthropic API)
// - Token usage tracking (including cache metrics)

import type {
  Provider,
  ProviderConfig,
  ProviderRequest,
  ProviderResponse,
  Message,
  ContentBlock,
  TokenUsage,
  ToolDefinition,
} from '../types.js';

export class AnthropicProvider implements Provider {
  readonly type = 'anthropic' as const;
  private config: ProviderConfig;
  // Will use: import Anthropic from '@anthropic-ai/sdk';

  constructor(config: ProviderConfig) {
    this.config = config;
  }

  async chat(request: ProviderRequest): Promise<ProviderResponse> {
    // TODO: implement using @anthropic-ai/sdk
    //
    // Key implementation notes:
    //
    // 1. System prompt: split into static + dynamic parts
    //    Place cache_control on each stable boundary
    //
    // 2. Messages: convert Agentic Message[] → Anthropic MessageParam[]
    //    - tool_result goes inside user messages as content blocks
    //    - tool_use comes from assistant messages
    //
    // 3. Cache breakpoints: place cache_control on:
    //    - Last system prompt block (breakpoint 1)
    //    - Last tool definition (breakpoint 2, via tools param)
    //    - Stable conversation history boundary (breakpoint 3)
    //    - Latest message (breakpoint 4, auto-moves)
    //
    // 4. Usage: extract from response.usage:
    //    - input_tokens, output_tokens
    //    - cache_creation_input_tokens (write)
    //    - cache_read_input_tokens (read)
    //
    // Example structure:
    //
    // const anthropic = new Anthropic({
    //   apiKey: this.config.apiKey,
    //   baseURL: this.config.baseUrl,
    // });
    //
    // const response = await anthropic.messages.create({
    //   model: this.config.model,
    //   max_tokens: 8192,
    //   system: buildSystemBlocks(request.systemPrompt, request.cacheBreakpoints),
    //   tools: buildToolBlocks(request.tools, request.cacheBreakpoints),
    //   messages: buildMessageBlocks(request.messages, request.cacheBreakpoints),
    // });

    throw new Error('AnthropicProvider not yet implemented');
  }
}

// ----- Cache Breakpoint Strategy -----
//
// The key insight for high cache hit rates:
//
// ┌──────────────────────────────┐
// │ System Prompt (static)       │ ← cache_control: ephemeral  [BREAKPOINT 1]
// │   - Base instructions        │    NEVER changes between requests
// │   - Permission rules         │
// ├──────────────────────────────┤
// │ System Prompt (dynamic)      │ ← cache_control: ephemeral  [BREAKPOINT 2]
// │   - Skills (from .md files)  │    Changes only when skills change
// │   - CLAUDE.md / AGENTS.md    │
// ├──────────────────────────────┤
// │ Tool Definitions             │    Cached as part of system
// │   - Custom tools             │    Changes only when tools change
// ├──────────────────────────────┤
// │ Conversation History         │ ← cache_control: ephemeral  [BREAKPOINT 3]
// │   - Messages 1..N-1          │    Grows, but prefix is stable
// │   (after compaction:         │    After compaction: resets but then stable
// │    summary + recent)         │
// ├──────────────────────────────┤
// │ Latest Message               │ ← auto breakpoint            [BREAKPOINT 4]
// │   - User's new input         │    Changes every request
// └──────────────────────────────┘
//
// CRITICAL: Compaction must be BATCH (all at once), not incremental.
// If you change message[5] in request N and message[8] in request N+1,
// the prefix changes both times → cache miss both times.
// Instead: change messages[5..20] ALL AT ONCE in one compaction pass.
