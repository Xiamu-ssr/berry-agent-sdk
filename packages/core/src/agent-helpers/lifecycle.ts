import type { HandRegistry } from '../hands.js';
import type { MemoryProvider } from '../memory/provider.js';
import type { AgentRunState } from './run-state.js';

export interface AgentLifecycleDestroyDeps {
  readonly runState: AgentRunState;
  readonly hands: HandRegistry;
  readonly handToolNames: Map<string, Set<string>>;
  readonly memoryProvider?: MemoryProvider;
  setStatus(status: 'destroyed', detail?: string): void;
  logWarn?(message: string, err: unknown): void;
}

/** Release all runtime resources owned by one Agent instance. */
export async function destroyAgentRuntime(deps: AgentLifecycleDestroyDeps): Promise<void> {
  if (deps.runState.isDestroyed) return;
  const warn = deps.logWarn ?? ((message, err) => console.warn(message, err));

  deps.runState.abortActiveTurn('agent destroyed');
  deps.runState.clearInterjects();
  deps.handToolNames.clear();
  deps.setStatus('destroyed');

  await Promise.all([
    disposeHands(deps.hands, warn),
    disposeMemoryProvider(deps.memoryProvider, warn),
  ]);
}

async function disposeHands(
  hands: HandRegistry,
  warn: (message: string, err: unknown) => void,
): Promise<void> {
  try {
    await hands.disposeAll();
  } catch (err) {
    warn('[agent] disposing hands threw:', err);
  }
}

async function disposeMemoryProvider(
  memoryProvider: MemoryProvider | undefined,
  warn: (message: string, err: unknown) => void,
): Promise<void> {
  try {
    await memoryProvider?.dispose?.();
  } catch (err) {
    warn('[agent] disposing memory provider threw:', err);
  }
}
