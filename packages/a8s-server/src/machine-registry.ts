// ============================================================
// @berry-agent/a8s-server — Machine registry (in-memory)
// ============================================================
//
// Tracks machines that have registered a connector (the machine layer).
// Mirrors the in-memory `tokens` map for workers: machines are ephemeral
// runtime state, not durable orchestration rows — a machine is "present"
// only while its connector heartbeats. On a8s restart the table is empty
// until connectors re-register (their heartbeat loop re-registers on
// 401/404, so recovery is automatic).
//
// a8s holds the machine token here and never hands it to a worker or an
// agent. When an agent's exec Hand wants to run a command on a machine,
// it calls a8s (admin-token scoped), and a8s — holding the machine token
// — forwards to the machine's /exec. a8s is the broker; machine
// credentials never leave it. This is the same "a8s holds connections,
// not the keys it brokers" stance as the rest of the control plane.

import { randomBytes } from 'node:crypto';
import type { MachineMcpTool, MachineRegistrationRequest } from '@berry-agent/cluster-protocol';

export interface MachineEntry {
  machineId: string;
  token: string;
  callbackUrl: string;
  platform?: string;
  labels?: Record<string, string>;
  mcpServers: string[];
  /**
   * Flat MCP tool manifest the connector reported. a8s stores it
   * verbatim and hands it back to the brain for tool projection — it
   * never interprets MCP structure itself.
   */
  mcpTools: MachineMcpTool[];
  heartbeatTtlMs: number;
  registeredAt: number;
  heartbeatAt: number;
  /** Set when the connector withdrew cleanly; UI shows it before GC. */
  withdrawnAt?: number;
}

export type MachineState = 'active' | 'withdrawn' | 'expired';

export class MachineRegistry {
  private readonly machines = new Map<string, MachineEntry>();

  /** Register (or re-register) a machine. Idempotent on machineId. */
  register(req: MachineRegistrationRequest, now: number): MachineEntry {
    const existing = this.machines.get(req.machineId);
    // Re-registration keeps the same token if one exists (a connector
    // that re-registers after a transient a8s blip shouldn't invalidate
    // its own in-flight calls); fresh registration mints a new token.
    const token = existing?.token ?? randomBytes(24).toString('hex');
    const entry: MachineEntry = {
      machineId: req.machineId,
      token,
      callbackUrl: req.callbackUrl,
      platform: req.platform,
      labels: req.labels ? { ...req.labels } : undefined,
      mcpServers: [...(req.mcpServers ?? [])],
      mcpTools: [...(req.mcpManifest?.tools ?? [])],
      heartbeatTtlMs: req.heartbeatTtlMs,
      registeredAt: existing?.registeredAt ?? now,
      heartbeatAt: now,
    };
    this.machines.set(req.machineId, entry);
    return entry;
  }

  get(machineId: string): MachineEntry | undefined {
    return this.machines.get(machineId);
  }

  /** Verify a presented token against a machine's issued token. */
  verifyToken(machineId: string, token: string | null): boolean {
    const entry = this.machines.get(machineId);
    return !!entry && !!token && entry.token === token;
  }

  /** Refresh heartbeat. Returns false if the machine is unknown. */
  heartbeat(machineId: string, now: number): boolean {
    const entry = this.machines.get(machineId);
    if (!entry) return false;
    entry.heartbeatAt = now;
    entry.withdrawnAt = undefined;
    return true;
  }

  withdraw(machineId: string): void {
    this.machines.delete(machineId);
  }

  /** Derived state for the operator view. */
  stateOf(entry: MachineEntry, now: number): MachineState {
    if (entry.withdrawnAt) return 'withdrawn';
    if (now > entry.heartbeatAt + entry.heartbeatTtlMs) return 'expired';
    return 'active';
  }

  list(): MachineEntry[] {
    return [...this.machines.values()];
  }

  /** Machines currently usable (heartbeat fresh, not withdrawn). */
  listActive(now: number): MachineEntry[] {
    return this.list().filter((m) => this.stateOf(m, now) === 'active');
  }
}
