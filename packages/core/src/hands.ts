// ============================================================
// Berry Agent SDK — Hands / Capability Boundary
// ============================================================
//
// A Hand is an execution surface behind the agent harness: local shell,
// filesystem, browser, MCP server, remote sandbox, mobile/device bridge, etc.
// The harness talks to capabilities; host products decide whether a hand runs
// in-process, as a subprocess, in a container, or on a remote machine.

import { z } from 'zod';
import { errorMessage } from '@berry-agent/small-shared-core';
import { ToolGroup } from './tool-types.js';
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

const toolSourceSchema = z.object({
  kind: z.enum(['builtin', 'mcp', 'hand']),
  server: z.string().optional(),
  hand: z.string().optional(),
  handKind: z.string().optional(),
}).strict();

export const handCapabilityPolicySchema = z.object({
  allowHands: z.array(z.string().min(1)).optional(),
  denyHands: z.array(z.string().min(1)).optional(),
  allowKinds: z.array(z.string().min(1)).optional(),
  denyKinds: z.array(z.string().min(1)).optional(),
  allowCapabilities: z.array(z.string().min(1)).optional(),
  denyCapabilities: z.array(z.string().min(1)).optional(),
  allowTools: z.array(z.string().min(1)).optional(),
  denyTools: z.array(z.string().min(1)).optional(),
  allowToolGroups: z.array(z.nativeEnum(ToolGroup)).optional(),
  denyToolGroups: z.array(z.nativeEnum(ToolGroup)).optional(),
  allowMcpServers: z.array(z.string().min(1)).optional(),
  denyMcpServers: z.array(z.string().min(1)).optional(),
}).strict();
export type HandCapabilityPolicy = z.infer<typeof handCapabilityPolicySchema>;

export const handCapabilityAuditEventSchema = z.object({
  timestamp: z.number().int().nonnegative(),
  phase: z.enum(['expose', 'execute']),
  action: z.enum(['allow', 'deny']),
  reason: z.string().optional(),
  handId: z.string().min(1),
  handKind: z.string().min(1),
  capabilityId: z.string().min(1),
  toolName: z.string().min(1),
  toolGroup: z.nativeEnum(ToolGroup),
  source: toolSourceSchema.optional(),
}).strict();
export type HandCapabilityAuditEvent = z.infer<typeof handCapabilityAuditEventSchema>;
export type HandCapabilityAuditSink = (event: HandCapabilityAuditEvent) => void | Promise<void>;

export interface HandCapabilityPolicyContext {
  handId: string;
  handKind: HandKind;
  capabilityId: string;
  toolName: string;
  toolGroup: ToolGroup;
  source?: ToolRegistration['source'];
}

export type HandCapabilityPolicyDecision =
  | { action: 'allow' }
  | { action: 'deny'; reason: string };

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
          content: errorMessage(err),
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
  policy?: HandCapabilityPolicy;
  auditSink?: HandCapabilityAuditSink;
  now?: () => number;
}

export function evaluateHandCapabilityPolicy(
  policy: HandCapabilityPolicy | undefined,
  context: HandCapabilityPolicyContext,
): HandCapabilityPolicyDecision {
  if (!policy) return { action: 'allow' };

  const denyReason =
    deniedByList(policy.denyHands, context.handId, `hand "${context.handId}" is denied`) ??
    deniedByList(policy.denyKinds, context.handKind, `hand kind "${context.handKind}" is denied`) ??
    deniedByList(policy.denyCapabilities, context.capabilityId, `capability "${context.capabilityId}" is denied`) ??
    deniedByList(policy.denyTools, context.toolName, `tool "${context.toolName}" is denied`) ??
    deniedByList(policy.denyToolGroups, context.toolGroup, `tool group "${context.toolGroup}" is denied`) ??
    deniedByList(
      policy.denyMcpServers,
      context.source?.kind === 'mcp' ? context.source.server : undefined,
      `MCP server "${context.source?.server}" is denied`,
    );
  if (denyReason) return { action: 'deny', reason: denyReason };

  const allowReason =
    missingFromAllowList(policy.allowHands, context.handId, `hand "${context.handId}" is not allowed`) ??
    missingFromAllowList(policy.allowKinds, context.handKind, `hand kind "${context.handKind}" is not allowed`) ??
    missingFromAllowList(policy.allowCapabilities, context.capabilityId, `capability "${context.capabilityId}" is not allowed`) ??
    missingFromAllowList(policy.allowTools, context.toolName, `tool "${context.toolName}" is not allowed`) ??
    missingFromAllowList(policy.allowToolGroups, context.toolGroup, `tool group "${context.toolGroup}" is not allowed`) ??
    missingFromAllowList(
      policy.allowMcpServers,
      context.source?.kind === 'mcp' ? context.source.server : undefined,
      `MCP server "${context.source?.server ?? '(none)'}" is not allowed`,
    );
  if (allowReason) return { action: 'deny', reason: allowReason };

  return { action: 'allow' };
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
  const now = options.now ?? Date.now;

  for (const hand of hands) {
    for (const capability of hand.capabilities()) {
      const toolName = capability.definition.name;
      if (include && !include.has(toolName) && !include.has(capability.id)) continue;
      if (exclude.has(toolName) || exclude.has(capability.id)) continue;
      const policyContext = createPolicyContext(hand, capability);
      const exposeDecision = evaluateHandCapabilityPolicy(options.policy, policyContext);
      emitHandCapabilityAudit(options.auditSink, {
        timestamp: now(),
        phase: 'expose',
        ...policyContext,
        action: exposeDecision.action,
        ...(exposeDecision.action === 'deny' ? { reason: exposeDecision.reason } : {}),
      });
      if (exposeDecision.action === 'deny') continue;
      if (seen.has(toolName)) {
        if (onCollision === 'skip') continue;
        throw new Error(`Duplicate hand tool name "${toolName}" from hand "${hand.id}"`);
      }
      seen.add(toolName);

      tools.push({
        definition: capability.definition,
        execute: async (input, context) => {
          const executeDecision = evaluateHandCapabilityPolicy(options.policy, policyContext);
          emitHandCapabilityAudit(options.auditSink, {
            timestamp: now(),
            phase: 'execute',
            ...policyContext,
            action: executeDecision.action,
            ...(executeDecision.action === 'deny' ? { reason: executeDecision.reason } : {}),
          });
          if (executeDecision.action === 'deny') {
            return {
              content: `Capability denied by hand policy: ${executeDecision.reason}`,
              isError: true,
            };
          }
          return hand.execute({ capabilityId: capability.id, input }, {
            ...context,
            handId: hand.id,
            handKind: hand.kind,
            capability,
          });
        },
        source: capability.source ?? { kind: 'hand', hand: hand.id, handKind: hand.kind },
      });
    }
  }

  return tools;
}

function createPolicyContext(hand: Hand, capability: HandCapability): HandCapabilityPolicyContext {
  return {
    handId: hand.id,
    handKind: hand.kind,
    capabilityId: capability.id,
    toolName: capability.definition.name,
    toolGroup: capability.definition.group ?? ToolGroup.Other,
    source: capability.source ?? { kind: 'hand', hand: hand.id, handKind: hand.kind },
  };
}

function deniedByList<T extends string>(
  denyList: readonly T[] | undefined,
  value: T | undefined,
  reason: string,
): string | null {
  return value !== undefined && denyList?.includes(value) ? reason : null;
}

function missingFromAllowList<T extends string>(
  allowList: readonly T[] | undefined,
  value: T | undefined,
  reason: string,
): string | null {
  return allowList?.length && (value === undefined || !allowList.includes(value)) ? reason : null;
}

function emitHandCapabilityAudit(
  sink: HandCapabilityAuditSink | undefined,
  event: HandCapabilityAuditEvent,
): void {
  if (!sink) return;
  try {
    void Promise.resolve(sink(handCapabilityAuditEventSchema.parse(event))).catch((err) => {
      console.error('[hand] audit sink rejected:', err);
    });
  } catch (err) {
    console.error('[hand] audit sink threw:', err);
  }
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
