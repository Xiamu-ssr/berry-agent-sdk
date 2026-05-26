// ============================================================
// Berry Agent SDK - Managed MCP Runtime
// ============================================================

import { z } from 'zod';
import type { Hand } from '@berry-agent/core';
import { MCPClient } from './client.js';
import type { MCPServerConfig } from './config.js';
import { createMCPHand, defaultMCPPrefix } from './adapter.js';

export const MCP_SERVER_STATES = ['connecting', 'connected', 'failed', 'disabled'] as const;
export const mcpServerStatusSchema = z.enum(MCP_SERVER_STATES);
export type MCPServerStatus = z.infer<typeof mcpServerStatusSchema>;

export const mcpServerStatusViewSchema = z.object({
  name: z.string().min(1),
  connected: z.boolean(),
  toolCount: z.number().int().nonnegative(),
  status: mcpServerStatusSchema,
  lastError: z.string().optional(),
  lastStartedAt: z.string().optional(),
}).strict();
export type MCPServerStatusView = z.infer<typeof mcpServerStatusViewSchema>;

export const mcpManagerStatusSchema = z.object({
  shared: z.array(mcpServerStatusViewSchema),
  perAgent: z.record(z.array(mcpServerStatusViewSchema)),
}).strict();
export type MCPManagerStatus = z.infer<typeof mcpManagerStatusSchema>;

export interface MCPManagerOptions {
  onChange?: () => void;
  connectTimeoutMs?: number;
  now?: () => Date;
  defaultPrefix?: (serverName: string) => string;
  clientFactory?: (config: MCPClientFactoryConfig) => MCPClient;
}

export interface MCPClientFactoryConfig {
  name: string;
  config: MCPServerConfig;
  connectTimeoutMs: number;
}

interface ManagedServer {
  client: MCPClient | null;
  hand: Hand | null;
  config: MCPServerConfig;
  toolCount: number;
  status: MCPServerStatus;
  lastError?: string;
  lastStartedAt?: string;
}

/**
 * Owns MCP server lifecycle and exposes connected servers as SDK Hands.
 *
 * Host products decide where config files live and how status is rendered.
 * The connect/restart/disable/release semantics stay in the SDK MCP package,
 * so products do not need their own MCP lifecycle state machine.
 */
export class MCPManager {
  private readonly sharedServers = new Map<string, ManagedServer>();
  private readonly agentServers = new Map<string, Map<string, ManagedServer>>();
  private readonly onChange?: () => void;
  private readonly connectTimeoutMs: number;
  private readonly now: () => Date;
  private readonly defaultPrefix: (serverName: string) => string;
  private readonly clientFactory: (config: MCPClientFactoryConfig) => MCPClient;

  constructor(options: MCPManagerOptions = {}) {
    this.onChange = options.onChange;
    this.connectTimeoutMs = options.connectTimeoutMs ?? 10_000;
    this.now = options.now ?? (() => new Date());
    this.defaultPrefix = options.defaultPrefix ?? defaultMCPPrefix;
    this.clientFactory = options.clientFactory ?? (({ name, config, connectTimeoutMs }) => new MCPClient({
      name,
      transport: config.transport,
      connectTimeoutMs,
    }));
  }

  async startSharedServers(configs: Record<string, MCPServerConfig>): Promise<void> {
    await Promise.allSettled(
      Object.entries(configs)
        .filter(([, config]) => config.shared)
        .map(([name, config]) => this.connectOne('shared', null, name, config)),
    );
  }

  async startAgentServers(
    agentId: string,
    configs: Record<string, MCPServerConfig>,
  ): Promise<Hand[]> {
    await Promise.allSettled(
      Object.entries(configs)
        .filter(([, config]) => !config.shared)
        .map(([name, config]) => this.connectOne('agent', agentId, name, config)),
    );
    return this.getHandsForAgent(agentId);
  }

  async restartShared(name: string, config: MCPServerConfig): Promise<MCPServerStatusView> {
    await this.disconnect(this.sharedServers.get(name));
    await this.connectOne('shared', null, name, config);
    return this.describeRequired('shared', null, name);
  }

  async restartAgent(
    agentId: string,
    name: string,
    config: MCPServerConfig,
  ): Promise<MCPServerStatusView> {
    await this.disconnect(this.agentServers.get(agentId)?.get(name));
    await this.connectOne('agent', agentId, name, config);
    return this.describeRequired('agent', agentId, name);
  }

  async disableShared(name: string, config: MCPServerConfig): Promise<MCPServerStatusView> {
    await this.disableOne('shared', null, name, config);
    return this.describeRequired('shared', null, name);
  }

  async disableAgent(
    agentId: string,
    name: string,
    config: MCPServerConfig,
  ): Promise<MCPServerStatusView> {
    await this.disableOne('agent', agentId, name, config);
    return this.describeRequired('agent', agentId, name);
  }

  async releaseAgent(agentId: string): Promise<void> {
    const servers = this.agentServers.get(agentId);
    if (!servers) return;

    for (const [name, managed] of servers) {
      try {
        await this.disconnect(managed);
      } catch (err) {
        console.error(
          `[MCP] Error disconnecting per-agent server "${name}" for agent "${agentId}":`,
          err instanceof Error ? err.message : err,
        );
      }
    }

    this.agentServers.delete(agentId);
    this.emitChange();
  }

  getHandsForAgent(agentId: string): Hand[] {
    const hands: Hand[] = [];

    for (const managed of this.sharedServers.values()) {
      if (managed.hand) hands.push(managed.hand);
    }

    const perAgent = this.agentServers.get(agentId);
    if (perAgent) {
      for (const managed of perAgent.values()) {
        if (managed.hand) hands.push(managed.hand);
      }
    }

    return hands;
  }

  getStatus(): MCPManagerStatus {
    const shared = [...this.sharedServers.entries()].map(([name, managed]) => this.describe(managed, name));
    const perAgent: Record<string, MCPServerStatusView[]> = {};
    for (const [agentId, servers] of this.agentServers) {
      perAgent[agentId] = [...servers.entries()].map(([name, managed]) => this.describe(managed, name));
    }
    return { shared, perAgent };
  }

  async shutdown(): Promise<void> {
    for (const [name, managed] of this.sharedServers) {
      try {
        await this.disconnect(managed);
      } catch (err) {
        console.error(`[MCP] Error disconnecting shared server "${name}":`, err instanceof Error ? err.message : err);
      }
    }
    this.sharedServers.clear();

    for (const agentId of [...this.agentServers.keys()]) {
      await this.releaseAgent(agentId);
    }

    this.emitChange();
  }

  private async connectOne(
    scope: 'shared' | 'agent',
    agentId: string | null,
    name: string,
    config: MCPServerConfig,
  ): Promise<void> {
    if (!config.enabled) {
      await this.disableOne(scope, agentId, name, config);
      return;
    }

    this.storeManaged(scope, agentId, name, {
      client: null,
      hand: null,
      config,
      toolCount: 0,
      status: 'connecting',
    });
    this.emitChange();

    try {
      const client = this.clientFactory({ name, config, connectTimeoutMs: this.connectTimeoutMs });
      await client.connect();
      const hand = await createMCPHand(
        client,
        config.prefix !== undefined
          ? { prefix: config.prefix }
          : { autoPrefix: this.defaultPrefix(name) },
      );
      this.storeManaged(scope, agentId, name, {
        client,
        hand,
        config,
        toolCount: hand.capabilities().length,
        status: 'connected',
        lastStartedAt: this.now().toISOString(),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const label = scope === 'shared' ? 'shared' : `agent "${agentId}"`;
      console.error(`[MCP] ${label} server "${name}" failed:`, msg);
      this.storeManaged(scope, agentId, name, {
        client: null,
        hand: null,
        config,
        toolCount: 0,
        status: 'failed',
        lastError: msg,
        lastStartedAt: this.now().toISOString(),
      });
    } finally {
      this.emitChange();
    }
  }

  private async disableOne(
    scope: 'shared' | 'agent',
    agentId: string | null,
    name: string,
    config: MCPServerConfig,
  ): Promise<void> {
    await this.disconnect(this.getManaged(scope, agentId, name));
    this.storeManaged(scope, agentId, name, {
      client: null,
      hand: null,
      config,
      toolCount: 0,
      status: 'disabled',
    });
    this.emitChange();
  }

  private async disconnect(managed: ManagedServer | undefined): Promise<void> {
    if (!managed?.client) return;
    try {
      await managed.hand?.dispose?.();
    } finally {
      await managed.client.disconnect();
    }
  }

  private storeManaged(
    scope: 'shared' | 'agent',
    agentId: string | null,
    name: string,
    entry: ManagedServer,
  ): void {
    if (scope === 'shared') {
      this.sharedServers.set(name, entry);
      return;
    }

    const key = agentId ?? '';
    let bucket = this.agentServers.get(key);
    if (!bucket) {
      bucket = new Map();
      this.agentServers.set(key, bucket);
    }
    bucket.set(name, entry);
  }

  private getManaged(scope: 'shared' | 'agent', agentId: string | null, name: string): ManagedServer | undefined {
    return scope === 'shared'
      ? this.sharedServers.get(name)
      : this.agentServers.get(agentId ?? '')?.get(name);
  }

  private describeRequired(scope: 'shared' | 'agent', agentId: string | null, name: string): MCPServerStatusView {
    const managed = this.getManaged(scope, agentId, name);
    if (!managed) throw new Error(`MCP server not managed: ${name}`);
    return this.describe(managed, name);
  }

  private describe(managed: ManagedServer, name: string): MCPServerStatusView {
    return {
      name,
      connected: managed.status === 'connected',
      toolCount: managed.toolCount,
      status: managed.status,
      lastError: managed.lastError,
      lastStartedAt: managed.lastStartedAt,
    };
  }

  private emitChange(): void {
    try {
      this.onChange?.();
    } catch (err) {
      console.error('[MCP] onChange listener threw:', err);
    }
  }
}
