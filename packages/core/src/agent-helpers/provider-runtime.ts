import type {
  ModelRefResolver,
  ProviderConfig,
  ProviderInput,
  ProviderResolver,
} from '../provider-types.js';
import { isProviderResolver } from './provider.js';

export interface ProviderRuntimeResolution {
  providerResolver: ProviderResolver | null;
  providerConfig: ProviderConfig;
}

export function resolveProviderInput(input: ProviderInput): ProviderRuntimeResolution {
  if (isProviderResolver(input)) {
    return {
      providerResolver: input,
      providerConfig: input.resolve(),
    };
  }
  return {
    providerResolver: null,
    providerConfig: input,
  };
}

export function resolveModelRefRuntime(
  modelRef: string,
  modelResolver: ModelRefResolver | null,
  currentConfig: ProviderConfig,
): ProviderRuntimeResolution {
  if (!modelResolver) {
    return {
      providerResolver: null,
      providerConfig: { ...currentConfig, model: modelRef },
    };
  }
  return resolveProviderInput(modelResolver(modelRef));
}

export function resolveInitialProviderRuntime({
  provider,
  metadataModel,
  modelResolver,
  reasoningEffort,
}: {
  provider: ProviderInput;
  metadataModel?: string;
  modelResolver: ModelRefResolver | null;
  reasoningEffort?: ProviderConfig['reasoningEffort'];
}): ProviderRuntimeResolution {
  const runtime = isProviderResolver(provider)
    ? resolveProviderInput(provider)
    : metadataModel
      ? resolveModelRefRuntime(metadataModel, modelResolver, provider)
      : resolveProviderInput(provider);

  if (!reasoningEffort) return runtime;
  return {
    ...runtime,
    providerConfig: { ...runtime.providerConfig, reasoningEffort },
  };
}
