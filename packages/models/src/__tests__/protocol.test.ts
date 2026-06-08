import { describe, it, expect } from 'vitest';
import { modelProtocolFamily } from '../protocol.js';

describe('modelProtocolFamily', () => {
  it.each([
    // Anthropic family by model id
    ['claude-opus-4.7', undefined, 'anthropic'],
    ['claude-sonnet-4-6', undefined, 'anthropic'],
    ['claude-haiku-4-5-20251001', undefined, 'anthropic'],
    ['opus', undefined, 'anthropic'],
    ['sonnet', undefined, 'anthropic'],
    ['haiku', undefined, 'anthropic'],
    ['tier:strong-opus', undefined, 'anthropic'],
    // Anthropic family inferred from remoteModelId (zenmux/openrouter style)
    ['my-strong-model', 'anthropic/claude-opus-4.7', 'anthropic'],
    ['gateway-x', 'anthropic/claude-sonnet-4.6', 'anthropic'],
    // OpenAI family
    ['gpt-5', undefined, 'openai'],
    ['gpt-5-mini', undefined, 'openai'],
    ['o4-mini', undefined, 'openai'],
    ['kimi-k2.6', undefined, 'openai'],
    ['gemini-3.1-pro', undefined, 'openai'],
    ['deepseek-reasoner', undefined, 'openai'],
    ['glm-5.1', undefined, 'openai'],
    // remoteModelId openai wins only when modelId is not anthropic-family
    ['gemini-pro', 'google/gemini-3.1-pro-preview', 'openai'],
    // anthropic-family modelId beats a non-anthropic remoteModelId
    ['claude-opus-4.7', 'openai/gpt-5', 'anthropic'],
  ])('modelProtocolFamily(%s, %s) → %s', (modelId, remoteModelId, expected) => {
    expect(modelProtocolFamily(modelId as string, remoteModelId as string | undefined)).toBe(expected);
  });

  it('does not match "claude" as a substring of an unrelated word', () => {
    // The family regex is delimiter-anchored, so words merely containing the
    // letters must not be misclassified.
    expect(modelProtocolFamily('opusculum-model')).toBe('openai');
    expect(modelProtocolFamily('sonneteer')).toBe('openai');
  });
});
