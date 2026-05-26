// ============================================================
// Berry Agent SDK — Hands / Capability Boundary
// ============================================================
//
// A Hand is an execution surface behind the agent harness: local shell,
// filesystem, browser, MCP server, remote sandbox, mobile/device bridge, etc.
// The harness talks to capabilities; host products decide whether a hand runs
// in-process, as a subprocess, in a container, or on a remote machine.

import { z } from 'zod';
import type { ToolContext, ToolDefinition, ToolRegistration, ToolResult } from './tool-types.js';

export type HandKind =
  | 'local'
  | 'filesystem'
  | 'shell'
  | 'browser'
  | 'mcp'
  | 'remote-sandbox'
  | 'system'
  | (string & {});

export const HAND_STATES = ['idle', 'starting', 'ready', 'busy', 'failed', 'stopped'] as const;

export const handStateSchema = z.enum(HAND_STATES);
export type HandState = z.infer<typeof handStateSchema>;

export const handStatusSchema = z.object({
  id: z.string().min(1),
  kind: z.string().min(1),
  displayName: z.string().optional(),
  state: handStateSchema,
  detail: z.string().optional(),
}).strict();
export type HandStatus = z.infer<typeof handStatusSchema>;

export interface HandCapability {
  /** Stable id inside the hand. Defaults to `definition.name` for tool-backed hands. */
  id: string;
  /** Tool-compatible schema exposed to the model. */
  definition: ToolDefinition;
  /**
   * Optional upstream provenance for this capability. When omitted the adapter
   * stamps `source.kind = 'hand'`; MCP-backed hands can preserve `kind = 'mcp'`
   * so existing UI/introspection keeps grouping by MCP server.
   */
  source?: ToolRegistration['source'];
}

export interface HandCall {
  capabilityId: string;
  input: Record<string, unknown>;
}

export interface HandContext extends ToolContext {
  handId: string;
  handKind: HandKind;
  capability: HandCapability;
}

export interface Hand {
  readonly id: string;
  readonly kind: HandKind;
  readonly displayName?: string;
  capabilities(): readonly HandCapability[];
  status?(): HandStatus;
  execute(call: HandCall, context: HandContext): Promise<ToolResult>;
  dispose?(): Promise<void> | void;
}

export interface CreateToolHandOptions {
  id: string;
  kind?: HandKind;
  displayName?: string;
  tools: readonly ToolRegistration[];
  state?: HandState;
}

/**
 * Wrap existing in-process ToolRegistration objects as a Hand.
 *
 * This is the migration bridge: current SDK/host tools can cross the new
 * hand boundary immediately, then later move behind stdio/http/container
 * transports without changing the agent-facing tool schema.
 */
export function createToolRegistrationHand(options: CreateToolHandOptions): Hand {
  const byName = new Map(options.tools.map((tool) => [tool.definition.name, tool]));
  const disposers = [...new Set(options.tools.flatMap((tool) => tool.dispose ? [tool.dispose] : []))];
  const capabilities = options.tools.map((tool) => ({
    id: tool.definition.name,
    definition: tool.definition,
    source: tool.source,
  }));
  let state: HandState = options.state ?? 'ready';

  return {
    id: options.id,
    kind: options.kind ?? 'local',
    displayName: options.displayName,
    capabilities: () => capabilities,
    status: () => ({
      id: options.id,
      kind: options.kind ?? 'local',
      displayName: options.displayName,
      state,
    }),
    execute: async (call, context) => {
      const tool = byName.get(call.capabilityId);
      if (!tool) {
        return {
          content: `Capability not found on hand "${options.id}": ${call.capabilityId}`,
          isError: true,
        };
      }
      state = 'busy';
      try {
        return await tool.execute(call.input, context);
      } catch (err) {
        return {
          content: err instanceof Error ? err.message : String(err),
          isError: true,
        };
      } finally {
        state = 'ready';
      }
    },
    dispose: async () => {
      state = 'stopped';
      const results = await Promise.allSettled(disposers.map(async (dispose) => {
        await dispose();
      }));
      const rejected = results.find((result) => result.status === 'rejected');
      if (rejected) {
        throw rejected.reason;
      }
    },
  };
}

export interface HandToolAdapterOptions {
  include?: readonly string[];
  exclude?: readonly string[];
  onCollision?: 'throw' | 'skip';
}

/**
 * Adapt one or more Hands into model-visible ToolRegistrations.
 *
 * The model still sees normal tools. The provenance says they came from a
 * hand, which lets hosts surface execution topology without re-parsing names.
 */
export function createHandToolRegistrations(
  hands: Iterable<Hand>,
  options: HandToolAdapterOptions = {},
): ToolRegistration[] {
  const include = options.include ? new Set(options.include) : null;
  const exclude = new Set(options.exclude ?? []);
  const onCollision = options.onCollision ?? 'throw';
  const seen = new Set<string>();
  const tools: ToolRegistration[] = [];

  for (const hand of hands) {
    for (const capability of hand.capabilities()) {
      const toolName = capability.definition.name;
      if (include && !include.has(toolName) && !include.has(capability.id)) continue;
      if (exclude.has(toolName) || exclude.has(capability.id)) continue;
      if (seen.has(toolName)) {
        if (onCollision === 'skip') continue;
        throw new Error(`Duplicate hand tool name "${toolName}" from hand "${hand.id}"`);
      }
      seen.add(toolName);

      tools.push({
        definition: capability.definition,
        execute: async (input, context) => hand.execute(
          { capabilityId: capability.id, input },
          {
            ...context,
            handId: hand.id,
            handKind: hand.kind,
            capability,
          },
        ),
        source: capability.source ?? { kind: 'hand', hand: hand.id, handKind: hand.kind },
      });
    }
  }

  return tools;
}

export class HandRegistry {
  private readonly hands = new Map<string, Hand>();

  register(hand: Hand): void {
    if (this.hands.has(hand.id)) {
      throw new Error(`Hand already registered: ${hand.id}`);
    }
    this.hands.set(hand.id, hand);
  }

  /** Remove a hand from the registry without disposing it. */
  unregister(id: string): Hand | undefined {
    const hand = this.hands.get(id);
    this.hands.delete(id);
    return hand;
  }

  /** Remove a hand and dispose it. Matches ExecutionEnvironmentRegistry.drop. */
  async drop(id: string): Promise<Hand | undefined> {
    const hand = this.hands.get(id);
    if (!hand) return undefined;
    this.hands.delete(id);
    await hand.dispose?.();
    return hand;
  }

  get(id: string): Hand | undefined {
    return this.hands.get(id);
  }

  list(): Hand[] {
    return [...this.hands.values()];
  }

  statuses(): HandStatus[] {
    return this.list().map((hand) => hand.status?.() ?? ({
      id: hand.id,
      kind: hand.kind,
      displayName: hand.displayName,
      state: 'ready',
    }));
  }

  toolRegistrations(options?: HandToolAdapterOptions): ToolRegistration[] {
    return createHandToolRegistrations(this.hands.values(), options);
  }

  async disposeAll(): Promise<void> {
    const results = await Promise.allSettled(this.list().map(async (hand) => {
      await hand.dispose?.();
    }));
    this.hands.clear();
    const rejected = results.find((result) => result.status === 'rejected');
    if (rejected) throw rejected.reason;
  }
}
