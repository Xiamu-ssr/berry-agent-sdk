// ============================================================
// @berry-agent/a8s-server — Shared dependencies for routes
// ============================================================
//
// Routes need access to mutable server state (control plane, token
// table, audit log, metrics, etc). Rather than passing each one
// individually, the server constructs this bag once at startup and
// hands it to every route module's factory.

import type { ControlPlane } from '@berry-agent/a8s';
import type { AuditLog } from './audit.js';
import type { A8sMetrics } from './metrics.js';
import type { ModelsTemplateStore } from './models-template-store.js';

export interface WorkerTokenEntry {
  workerId: string;
  token: string;
  callbackUrl: string;
  capacity: number;
  heartbeatTtlMs: number;
}

export interface ServerDeps<TEntry = unknown> {
  readonly plane: ControlPlane<TEntry>;
  /** workerId → token entry, in-memory cache of registered workers. */
  readonly tokens: Map<string, WorkerTokenEntry>;
  readonly audit: AuditLog;
  readonly metrics: A8sMetrics;
  readonly modelsTemplate: ModelsTemplateStore;
  readonly logger: Pick<Console, 'log' | 'warn' | 'error'>;
  readonly adminToken: string | undefined;
  readonly advertiseUrl: string | undefined;
  readonly port: number;
  readonly version: string;
  readonly startedAt: number;
}
