// ============================================================
// Berry Agent SDK — Common Tools: Web Search (adapter pattern)
// ============================================================

import { TOOL_WEB_SEARCH } from '@berry-agent/core';
import type { CredentialStore, ToolRegistration } from '@berry-agent/core';

// ----- Public types -----

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface SearchProvider {
  search(query: string, options?: { count?: number }): Promise<SearchResult[]>;
}

export type WebSearchProviderName = 'tavily' | 'brave' | 'serpapi';

/**
 * Mapping from each provider to the credential key names it looks up.
 * Useful for Settings UIs ("which key do I need to configure?").
 */
export const WEB_SEARCH_CREDENTIAL_KEYS: Record<WebSearchProviderName, string> = {
  tavily: 'TAVILY_API_KEY',
  brave: 'BRAVE_API_KEY',
  serpapi: 'SERPAPI_API_KEY',
};

export interface WebSearchConfig {
  provider: WebSearchProviderName;
  /**
   * Credential store that resolves the provider's API key. Required when
   * `apiKey` is not passed explicitly.
   */
  credentials?: CredentialStore;
  /**
   * Direct API key. Takes precedence over `credentials.get(...)` when set.
   */
  apiKey?: string;
  /**
   * Override the credential key name (defaults to WEB_SEARCH_CREDENTIAL_KEYS).
   */
  credentialKey?: string;
  baseUrl?: string;
}

// ----- Built-in adapters -----

class TavilyAdapter implements SearchProvider {
  constructor(private apiKey: string, private baseUrl = 'https://api.tavily.com') {}

  async search(query: string, options?: { count?: number }): Promise<SearchResult[]> {
    const res = await fetch(`${this.baseUrl}/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: this.apiKey,
        query,
        max_results: options?.count ?? 5,
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`Tavily API error: ${res.status}`);
    const data = await res.json() as { results: Array<{ title: string; url: string; content: string }> };
    return (data.results ?? []).map(r => ({
      title: r.title,
      url: r.url,
      snippet: r.content,
    }));
  }
}

class BraveAdapter implements SearchProvider {
  constructor(private apiKey: string, private baseUrl = 'https://api.search.brave.com/res/v1') {}

  async search(query: string, options?: { count?: number }): Promise<SearchResult[]> {
    const params = new URLSearchParams({ q: query, count: String(options?.count ?? 5) });
    const res = await fetch(`${this.baseUrl}/web/search?${params}`, {
      headers: {
        Accept: 'application/json',
        'X-Subscription-Token': this.apiKey,
      },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`Brave Search API error: ${res.status}`);
    const data = await res.json() as { web?: { results?: Array<{ title: string; url: string; description: string }> } };
    return (data.web?.results ?? []).map(r => ({
      title: r.title,
      url: r.url,
      snippet: r.description,
    }));
  }
}

class SerpAPIAdapter implements SearchProvider {
  constructor(private apiKey: string, private baseUrl = 'https://serpapi.com') {}

  async search(query: string, options?: { count?: number }): Promise<SearchResult[]> {
    const params = new URLSearchParams({
      q: query,
      api_key: this.apiKey,
      num: String(options?.count ?? 5),
    });
    const res = await fetch(`${this.baseUrl}/search.json?${params}`, {
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`SerpAPI error: ${res.status}`);
    const data = await res.json() as { organic_results?: Array<{ title: string; link: string; snippet: string }> };
    return (data.organic_results ?? []).map(r => ({
      title: r.title,
      url: r.link,
      snippet: r.snippet,
    }));
  }
}

// ----- Factory -----

function resolveApiKey(config: WebSearchConfig): string | undefined {
  if (config.apiKey && config.apiKey.length > 0) return config.apiKey;
  const keyName = config.credentialKey ?? WEB_SEARCH_CREDENTIAL_KEYS[config.provider];
  return config.credentials?.get(keyName);
}

function createProvider(config: WebSearchConfig, apiKey: string): SearchProvider {
  switch (config.provider) {
    case 'tavily':
      return new TavilyAdapter(apiKey, config.baseUrl);
    case 'brave':
      return new BraveAdapter(apiKey, config.baseUrl);
    case 'serpapi':
      return new SerpAPIAdapter(apiKey, config.baseUrl);
  }
}

/**
 * Create a web_search tool with the specified search provider.
 * Config (provider + credentials) is set at creation time.
 *
 * If no API key can be resolved, returns a stub tool that reports the
 * missing credential to the agent at call time — so the tool is still
 * advertised but safely fails.
 */
export function createWebSearchTool(config: WebSearchConfig): ToolRegistration {
  const apiKey = resolveApiKey(config);
  const keyName = config.credentialKey ?? WEB_SEARCH_CREDENTIAL_KEYS[config.provider];

  if (!apiKey) {
    return {
      definition: {
        name: TOOL_WEB_SEARCH,
        description: `Search the web. Currently NOT configured (missing ${keyName}).`,
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search query' },
            count: { type: 'number', description: 'Number of results to return (default 5)' },
          },
          required: ['query'],
        },
      },
      execute: async () => ({
        content: `web_search is not configured: missing credential "${keyName}" for provider "${config.provider}". Ask the user to configure it.`,
        isError: true,
      }),
    };
  }

  const provider = createProvider(config, apiKey);

  return {
    definition: {
      name: TOOL_WEB_SEARCH,
      description: 'Search the web and return a list of results with title, URL, and snippet.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query' },
          count: { type: 'number', description: 'Number of results to return (default 5)' },
        },
        required: ['query'],
      },
    },
    execute: async (input) => {
      try {
        const query = input.query as string;
        const count = input.count as number | undefined;
        const results = await provider.search(query, { count });
        if (results.length === 0) {
          return { content: 'No search results found.' };
        }
        const formatted = results
          .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`)
          .join('\n\n');
        return { content: formatted };
      } catch (err) {
        return { content: `Error: ${err instanceof Error ? err.message : String(err)}`, isError: true };
      }
    },
  };
}
