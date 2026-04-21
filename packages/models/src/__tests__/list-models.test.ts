import { describe, it, expect, vi } from 'vitest';
import { listModels } from '../list-models.js';
import type { ProviderInstance } from '../types.js';
import { RAW_PRESET_ID } from '../presets.js';

function mockFetch(body: unknown, status = 200): typeof fetch {
  return vi.fn(async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    }),
  ) as unknown as typeof fetch;
}

describe('listModels', () => {
  it('returns known list for raw providers (no fetch)', async () => {
    const inst: ProviderInstance = {
      id: 'raw1',
      presetId: RAW_PRESET_ID,
      baseUrl: 'https://example.com',
      type: 'openai',
      apiKey: 'x',
      knownModels: ['zeta', 'alpha'],
    };
    const res = await listModels(inst);
    expect(res.source).toBe('known');
    expect(res.models).toEqual(['alpha', 'zeta']); // sorted
  });

  it('fetches live list from OpenAI-style /models (data array)', async () => {
    const inst: ProviderInstance = {
      id: 'openai_main',
      presetId: 'openai',
      apiKey: 'sk-xxx',
    };
    const fetchMock = mockFetch({
      data: [{ id: 'gpt-5' }, { id: 'o4-mini' }, { id: 'gpt-4o' }],
    });
    const res = await listModels(inst, { fetch: fetchMock });
    expect(res.source).toBe('live');
    expect(res.models).toEqual(['gpt-4o', 'gpt-5', 'o4-mini']);
  });

  it('extracts ids from Anthropic-style (models array)', async () => {
    const inst: ProviderInstance = {
      id: 'anthropic_main',
      presetId: 'anthropic',
      apiKey: 'sk-ant',
    };
    const fetchMock = mockFetch({
      models: [{ id: 'claude-opus-4.7' }, { id: 'claude-sonnet-4.6' }],
    });
    const res = await listModels(inst, { fetch: fetchMock });
    expect(res.source).toBe('live');
    expect(res.models).toEqual(['claude-opus-4.7', 'claude-sonnet-4.6']);
  });

  it('falls back to knownModels on HTTP error with a warning', async () => {
    const inst: ProviderInstance = {
      id: 'openai_main',
      presetId: 'openai',
      apiKey: 'sk-xxx',
    };
    const fetchMock = mockFetch({ error: 'unauthorized' }, 401);
    const res = await listModels(inst, { fetch: fetchMock });
    expect(res.source).toBe('known');
    expect(res.warning).toContain('401');
    expect(res.models.length).toBeGreaterThan(0);
  });

  it('falls back on network error', async () => {
    const inst: ProviderInstance = {
      id: 'openai_main',
      presetId: 'openai',
      apiKey: 'sk-xxx',
    };
    const fetchMock = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const res = await listModels(inst, { fetch: fetchMock });
    expect(res.source).toBe('known');
    expect(res.warning).toContain('ECONNREFUSED');
  });

  it('returns knownModels when preset has no listModelsPath', async () => {
    // glm preset has no listModelsPath
    const inst: ProviderInstance = {
      id: 'glm_main',
      presetId: 'glm',
      apiKey: 'key',
    };
    const res = await listModels(inst);
    expect(res.source).toBe('known');
    expect(res.models).toContain('glm-5.1');
  });

  it('sends anthropic-specific headers', async () => {
    const inst: ProviderInstance = {
      id: 'anthropic_main',
      presetId: 'anthropic',
      apiKey: 'sk-ant',
    };
    const fetchMock = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      expect(headers['x-api-key']).toBe('sk-ant');
      expect(headers['anthropic-version']).toBe('2023-06-01');
      return new Response(JSON.stringify({ data: [{ id: 'claude-opus-4.7' }] }), {
        status: 200,
      });
    }) as unknown as typeof fetch;
    await listModels(inst, { fetch: fetchMock });
    expect(fetchMock).toHaveBeenCalled();
  });
});
