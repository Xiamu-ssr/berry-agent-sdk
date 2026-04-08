// ============================================================
// Agentic SDK — OpenAI Provider
// ============================================================
// Wraps the official OpenAI SDK. Key differences from Anthropic:
// - Cache is AUTOMATIC (no explicit breakpoints needed)
// - Just keep the request prefix stable → automatic cache hit
// - tool_calls / function format instead of tool_use blocks
// - No thinking blocks

import type {
  Provider,
  ProviderConfig,
  ProviderRequest,
  ProviderResponse,
} from '../types.js';

export class OpenAIProvider implements Provider {
  readonly type = 'openai' as const;
  private config: ProviderConfig;

  constructor(config: ProviderConfig) {
    this.config = config;
  }

  async chat(request: ProviderRequest): Promise<ProviderResponse> {
    // TODO: implement using openai SDK
    //
    // Key differences from Anthropic:
    //
    // 1. No cache_control markers needed — OpenAI caches automatically
    //    Just ensure the request prefix (system + tools + early messages) is stable
    //
    // 2. Tool format:
    //    Anthropic: tool_use content block in assistant message
    //    OpenAI: tool_calls array on assistant message
    //
    //    Anthropic: tool_result content block in user message
    //    OpenAI: role: "tool" message with tool_call_id
    //
    // 3. No thinking blocks — OpenAI doesn't have extended thinking
    //    (though reasoning models like o3 have chain-of-thought internally)
    //
    // 4. Cache economics:
    //    OpenAI: free to write, 50% off reads
    //    Anthropic: +25% to write, 90% off reads
    //    → For long sessions, Anthropic is cheaper IF you get high hit rates
    //
    // Example:
    //
    // const openai = new OpenAI({
    //   apiKey: this.config.apiKey,
    //   baseURL: this.config.baseUrl,
    // });
    //
    // const response = await openai.chat.completions.create({
    //   model: this.config.model,
    //   messages: convertMessages(request),
    //   tools: convertTools(request.tools),
    // });

    throw new Error('OpenAIProvider not yet implemented');
  }
}
