import type { HandRegistry } from '../hands.js';
import type { MemoryProvider } from '../memory/provider.js';
import type { AgentRunState } from './run-state.js';

export interface AgentLifecycleDisposeDeps {
  readonly runState: AgentRunState;
  readonly hands: HandRegistry;
  readonly handToolNames: Map<string, Set<string>>;
  readonly memoryProvider?: MemoryProvider;
  setStatus(status: 'disposed', detail?: string): void;
  logWarn?(message: string, err: unknown): void;
}

/** Release all runtime resources owned by one Agent instance. */
export async function disposeAgentRuntime(deps: AgentLifecycleDisposeDeps): Promise<void> {
  if (deps.runState.isDisposed) return;
  const warn = deps.logWarn ?? ((message, err) => console.warn(message, err));

  deps.runState.abortActiveTurn('agent disposed');
  deps.runState.clearInterjects();
  deps.handToolNames.clear();
  deps.setStatus('disposed');

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
