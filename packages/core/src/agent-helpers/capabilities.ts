import type { Hand, HandRegistry, HandToolAdapterOptions } from '../hands.js';
import { createHandToolRegistrations, createToolRegistrationHand } from '../hands.js';
import type { MemoryProvider } from '../memory/provider.js';
import type { ToolRegistration } from '../tool-types.js';

export interface AgentCapabilityRegistry {
  tools: Map<string, ToolRegistration>;
  hands: HandRegistry;
  handToolNames: Map<string, Set<string>>;
}

export const CONFIGURED_TOOLS_HAND_ID = 'sdk:configured-tools';
export const MEMORY_PROVIDER_HAND_ID_PREFIX = 'sdk:memory-provider:';
export const RUNTIME_TOOL_HAND_ID_PREFIX = 'sdk:runtime-tool:';

export function registerConfiguredToolCapabilities(
  registry: AgentCapabilityRegistry,
  tools: readonly ToolRegistration[] | undefined,
): void {
  if (!tools?.length) return;
  registerToolRegistrationsAsHand(registry, {
    id: CONFIGURED_TOOLS_HAND_ID,
    displayName: 'Configured tools',
    tools,
  });
}

export function registerRuntimeToolCapability(
  registry: AgentCapabilityRegistry,
  tool: ToolRegistration,
): void {
  registerToolRegistrationsAsHand(registry, {
    id: `${RUNTIME_TOOL_HAND_ID_PREFIX}${tool.definition.name}`,
    displayName: `Runtime tool: ${tool.definition.name}`,
    tools: [tool],
  });
}

export function registerMemoryProviderCapabilities(
  registry: AgentCapabilityRegistry,
  memoryProvider: MemoryProvider | undefined,
): void {
  if (!memoryProvider) return;
  const tools = memoryProvider.tools();
  if (!tools.length) return;
  registerToolRegistrationsAsHand(registry, {
    id: `${MEMORY_PROVIDER_HAND_ID_PREFIX}${memoryProvider.id}`,
    displayName: `Memory provider: ${memoryProvider.id}`,
    tools,
  });
}

export async function unregisterToolCapability(
  registry: AgentCapabilityRegistry,
  name: string,
): Promise<boolean> {
  const removed = registry.tools.delete(name);
  if (!removed) return false;

  for (const [handId, names] of registry.handToolNames) {
    if (!names.delete(name)) continue;
    if (names.size === 0 && handId.startsWith(RUNTIME_TOOL_HAND_ID_PREFIX)) {
      const hand = registry.hands.unregister(handId);
      registry.handToolNames.delete(handId);
      await hand?.dispose?.();
    }
    return true;
  }

  return true;
}

export function registerHandCapabilities(
  registry: AgentCapabilityRegistry,
  hand: Hand,
  options?: HandToolAdapterOptions,
): void {
  if (registry.hands.get(hand.id)) {
    throw new Error(`Hand already registered: ${hand.id}`);
  }

  const registrations = createHandToolRegistrations([hand], options);
  for (const registration of registrations) {
    const name = registration.definition.name;
    if (registry.tools.has(name)) {
      throw new Error(`Tool "${name}" from hand "${hand.id}" collides with an existing tool`);
    }
  }

  registry.hands.register(hand);
  registry.handToolNames.set(
    hand.id,
    new Set(registrations.map((registration) => registration.definition.name)),
  );
  for (const registration of registrations) {
    registry.tools.set(registration.definition.name, registration);
  }
}

function registerToolRegistrationsAsHand(
  registry: AgentCapabilityRegistry,
  options: {
    id: string;
    displayName: string;
    tools: readonly ToolRegistration[];
  },
): void {
  registerHandCapabilities(registry, createToolRegistrationHand({
    id: options.id,
    kind: 'system',
    displayName: options.displayName,
    tools: options.tools,
  }));
}

export function unregisterHandCapabilities(
  registry: AgentCapabilityRegistry,
  handId: string,
): Hand | null {
  const hand = registry.hands.unregister(handId);
  if (!hand) return null;

  for (const name of registry.handToolNames.get(handId) ?? []) {
    registry.tools.delete(name);
  }
  registry.handToolNames.delete(handId);
  return hand;
}
