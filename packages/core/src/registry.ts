// ============================================================
// Berry Agent SDK — Provider Registry
// ============================================================
// Multi-provider management with model routing.
// Products register providers once; agents resolve by model name.

import type { ProviderConfig, ProviderType } from './types.js';

// ----- Types -----

export interface ProviderEntry {
  type: ProviderType;
  apiKey: string;
  baseUrl?: string;
  models: string[];
}

export interface ResolvedModel {
  providerName: string;
  provider: ProviderEntry;
  model: string;
}

// ----- Registry -----

export class ProviderRegistry {
  private providers = new Map<string, ProviderEntry>();
  private defaultModel: string | null = null;

  /** Register a provider with its available models. */
  register(name: string, entry: ProviderEntry): void {
    this.providers.set(name, entry);
  }

  /** Remove a provider. */
  unregister(name: string): void {
    this.providers.delete(name);
  }

  /** Set the default model. */
  setDefault(model: string): void {
    const resolved = this.resolve(model);
    if (!resolved) throw new Error(`Model "${model}" not found in any provider`);
    this.defaultModel = model;
  }

  /** Get the default model name. */
  getDefault(): string | null {
    return this.defaultModel;
  }

  /** Resolve a model to its provider. Returns null if not found. */
  resolve(model: string): ResolvedModel | null {
    for (const [name, entry] of this.providers) {
      if (entry.models.includes(model)) {
        return { providerName: name, provider: entry, model };
      }
    }
    return null;
  }

  /** Resolve a model (or default) to ProviderConfig for Agent construction. */
  toProviderConfig(model?: string): ProviderConfig {
    const target = model ?? this.defaultModel;
    if (!target) throw new Error('No model specified and no default model set');

    const resolved = this.resolve(target);
    if (!resolved) throw new Error(`Model "${target}" not found in any registered provider`);

    return {
      type: resolved.provider.type,
      apiKey: resolved.provider.apiKey,
      baseUrl: resolved.provider.baseUrl,
      model: resolved.model,
    };
  }

  /** List all available models across all providers. */
  listModels(): Array<{ model: string; providerName: string; type: ProviderType }> {
    const result: Array<{ model: string; providerName: string; type: ProviderType }> = [];
    for (const [name, entry] of this.providers) {
      for (const model of entry.models) {
        result.push({ model, providerName: name, type: entry.type });
      }
    }
    return result;
  }

  /** List registered provider names. */
  listProviders(): string[] {
    return [...this.providers.keys()];
  }

  /** Get a provider entry by name. */
  getProvider(name: string): ProviderEntry | undefined {
    return this.providers.get(name);
  }

  /** Check if any providers are registered. */
  get hasProviders(): boolean {
    return this.providers.size > 0;
  }
}
