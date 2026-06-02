// ============================================================
// Berry Agent SDK — Web Hand (env-less, agent-level)
// ============================================================
// web_fetch / web_search touch no machine: they make outbound HTTP calls
// and hold no executor. They are an agent-level capability, independent of
// any ExecutionEnvironment — the brain keeps them even if every machine is
// down. Per 新-1 they live in their own hand, never packed into the
// workspace (kitchen-bound) tools.

import {
  createToolRegistrationHand,
  type CredentialStore,
  type Hand,
} from '@berry-agent/core';
import {
  createWebSearchTool,
  WEB_SEARCH_CREDENTIAL_KEYS,
  type WebSearchProviderName,
} from './web-search.js';
import { createWebFetchTool } from './web-fetch.js';

export interface WebHandOptions {
  credentials: CredentialStore;
  /** Tool names to expose. Undefined means both web_fetch and web_search. */
  allowedTools?: string[];
  id?: string;
  displayName?: string;
}

/**
 * Build the web hand: web_fetch + web_search. No execution environment,
 * no executor. The search provider is picked from whichever credential is
 * present (tavily → brave → serpapi), defaulting to tavily.
 */
export function createWebHand(options: WebHandOptions): Hand {
  const tools = [
    createWebFetchTool(),
    createWebSearchTool({
      provider: pickWebSearchProvider(options.credentials) ?? 'tavily',
      credentials: options.credentials,
    }),
  ];
  const filtered = options.allowedTools
    ? tools.filter((t) => options.allowedTools!.includes(t.definition.name))
    : tools;

  return createToolRegistrationHand({
    id: options.id ?? 'web',
    kind: 'local',
    displayName: options.displayName ?? 'Web',
    tools: filtered,
  });
}

function pickWebSearchProvider(credentials: CredentialStore): WebSearchProviderName | null {
  const order: WebSearchProviderName[] = ['tavily', 'brave', 'serpapi'];
  for (const provider of order) {
    const key = WEB_SEARCH_CREDENTIAL_KEYS[provider];
    if (credentials.get(key)) return provider;
  }
  return null;
}
