import type { AgentEvent } from '../agent-runtime-types.js';
import type {
  ModelRefResolver,
  Provider,
  ProviderConfig,
  ProviderRequest,
  ProviderResponse,
  ProviderResolver,
} from '../provider-types.js';
import { saveAgentConfigSync, type ReasoningEffort } from '../workspace/initializer.js';
import { isRetryableError } from '../utils/retry.js';
import { callProvider } from './provider-call.js';
import { createProvider, providerConfigsEqual } from './provider.js';
import { resolveModelRefRuntime } from './provider-runtime.js';

export interface AgentProviderControllerOptions {
  provider: Provider;
  providerConfig: ProviderConfig;
  providerResolver: ProviderResolver | null;
  modelResolver: ModelRefResolver | null;
  homeRoot: string;
}

/**
 * Owns the live provider runtime for an Agent: resolver refresh, failover
 * reporting, model switching, reasoning effort changes, and provider calls.
 *
 * Agent orchestrates turns; this controller owns provider runtime mutation.
 */
export class AgentProviderController {
  private provider: Provider;
  private providerConfig: ProviderConfig;
  private providerResolver: ProviderResolver | null;
  private readonly modelResolver: ModelRefResolver | null;
  private readonly homeRoot: string;

  constructor(options: AgentProviderControllerOptions) {
    this.provider = options.provider;
    this.providerConfig = options.providerConfig;
    this.providerResolver = options.providerResolver;
    this.modelResolver = options.modelResolver;
    this.homeRoot = options.homeRoot;
  }

  get currentProvider(): Provider {
    return this.provider;
  }

  get currentConfig(): ProviderConfig {
    return this.providerConfig;
  }

  snapshotConfig(): ProviderConfig {
    return { ...this.providerConfig };
  }

  resetResolverForSession(): void {
    this.providerResolver?.resetForSession?.();
  }

  switchModel(modelRef: string): void {
    const runtime = resolveModelRefRuntime(modelRef, this.modelResolver, this.providerConfig);
    this.providerResolver = runtime.providerResolver;
    this.providerConfig = runtime.providerConfig;
    this.provider = createProvider(this.providerConfig);
    saveAgentConfigSync(this.homeRoot, { model: modelRef });
  }

  setReasoningEffort(effort: ReasoningEffort): void {
    this.providerResolver = null;
    this.providerConfig = { ...this.providerConfig, reasoningEffort: effort };
    this.provider = createProvider(this.providerConfig);
    saveAgentConfigSync(this.homeRoot, { reasoningEffort: effort });
  }

  async call(
    request: ProviderRequest,
    stream: boolean,
    emit: (event: AgentEvent) => void,
  ): Promise<ProviderResponse> {
    return callProvider(
      {
        getProvider: () => this.provider,
        refreshIfNeeded: () => this.refreshIfNeeded(),
        reportError: (err, statusCode) => this.reportError(err, statusCode),
      },
      request,
      stream,
      emit,
    );
  }

  private refreshIfNeeded(): void {
    if (!this.providerResolver) return;
    const next = this.providerResolver.resolve();
    if (!providerConfigsEqual(this.providerConfig, next)) {
      this.providerConfig = next;
      this.provider = createProvider(next);
    }
  }

  private reportError(err: unknown, statusCode?: number): boolean {
    if (!this.providerResolver?.reportError) return false;
    const isTransient =
      typeof statusCode === 'number'
        ? statusCode === 402 || statusCode === 408 || statusCode === 429 || statusCode >= 500
        : isRetryableError(err);
    try {
      return this.providerResolver.reportError(err, { isTransient, statusCode }) === true;
    } catch {
      return false;
    }
  }
}
