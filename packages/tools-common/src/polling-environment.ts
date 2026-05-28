// ============================================================
// @berry-agent/tools-common — Polling ExecutionEnvironment
// ============================================================
// Reverse of RemoteExecutionEnvironment: when the worker is behind a
// firewall and cannot receive inbound HTTP, but the remote executor
// host can make outbound calls, the worker becomes a *task queue* and
// the executor host polls.
//
// Architecture:
//
//   Worker (e.g. in cloud):
//     ↑ adds task to PullingTaskQueue, awaits result Promise
//     │
//   Executor host (e.g. user's Mac behind corporate firewall):
//     ↓ polls queue via PullingTaskTransport
//     ↓ executes command locally
//     ↑ POSTs result via PullingTaskTransport
//
// This file ships the executor side ("environment") and the queue side
// ("queue"); the transport between them is an interface, so consumers
// can plug HTTP polling, WebSocket, SQS, Redis pub-sub, etc.

import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type {
  CommandExecutor,
  ExecResult,
  ProcessHandle,
} from '@berry-agent/core';
import {
  createExecutionEnvironment,
  isolationPolicyFromScope,
  type AgentScope,
  type ExecutionEnvironment,
  type ExecutionEnvironmentProvider,
  type ExecutionEnvironmentProvisionRequest,
} from '@berry-agent/core';

// ============================================================
// Wire shapes (also exported for transports that need to validate)
// ============================================================

export const pullingTaskRequestSchema = z.object({
  taskId: z.string().min(1),
  command: z.string().min(1),
  cwd: z.string().min(1),
  env: z.record(z.string()),
  timeoutMs: z.number().int().positive().optional(),
}).strict();
export type PullingTaskRequest = z.infer<typeof pullingTaskRequestSchema>;

export const pullingTaskResultSchema = z.object({
  taskId: z.string().min(1),
  output: z.string(),
  isError: z.boolean(),
}).strict();
export type PullingTaskResult = z.infer<typeof pullingTaskResultSchema>;

// ============================================================
// Transport contract
// ============================================================
// Two sides:
//   - Queue side (sits in the worker): accepts enqueue, returns a Promise
//     that the worker awaits.
//   - Executor side (sits on the remote host): pulls one task at a time,
//     executes, pushes result.

/** Pluggable transport seen from the worker side. */
export interface PullingTaskQueue {
  /** Worker enqueues a task and waits for the result. */
  enqueue(task: PullingTaskRequest): Promise<PullingTaskResult>;
}

/** Pluggable transport seen from the executor side. */
export interface PullingTaskSource {
  /** Block until a task is available (or timeoutMs elapses → null). */
  poll(timeoutMs: number): Promise<PullingTaskRequest | null>;
  /** Push a result back. */
  postResult(result: PullingTaskResult): Promise<void>;
}

// ============================================================
// In-memory queue (default; ships for tests + same-process scenarios)
// ============================================================
// Implements both sides over a shared mutable array + waiter list.
// Real deployments will wrap an HTTP poll / WebSocket / SQS transport.

interface Pending {
  resolve: (result: PullingTaskResult) => void;
  reject: (error: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
}

export class InMemoryPullingTaskQueue implements PullingTaskQueue, PullingTaskSource {
  private readonly queued: PullingTaskRequest[] = [];
  private readonly waiters: Array<(task: PullingTaskRequest) => void> = [];
  private readonly pending = new Map<string, Pending>();

  async enqueue(task: PullingTaskRequest): Promise<PullingTaskResult> {
    return new Promise<PullingTaskResult>((resolve, reject) => {
      const timer = task.timeoutMs && task.timeoutMs > 0
        ? setTimeout(() => {
            this.pending.delete(task.taskId);
            reject(new Error(`PollingExecutionEnvironment: task "${task.taskId}" timed out after ${task.timeoutMs}ms`));
          }, task.timeoutMs)
        : undefined;
      this.pending.set(task.taskId, { resolve, reject, timer });
      const waiter = this.waiters.shift();
      if (waiter) waiter(task);
      else this.queued.push(task);
    });
  }

  async poll(timeoutMs: number): Promise<PullingTaskRequest | null> {
    const ready = this.queued.shift();
    if (ready) return ready;
    return new Promise<PullingTaskRequest | null>((resolve) => {
      const timer = setTimeout(() => {
        const idx = this.waiters.indexOf(waiter);
        if (idx >= 0) this.waiters.splice(idx, 1);
        resolve(null);
      }, timeoutMs);
      const waiter = (task: PullingTaskRequest) => {
        clearTimeout(timer);
        resolve(task);
      };
      this.waiters.push(waiter);
    });
  }

  async postResult(result: PullingTaskResult): Promise<void> {
    const pending = this.pending.get(result.taskId);
    if (!pending) return; // late result; tolerated
    this.pending.delete(result.taskId);
    if (pending.timer) clearTimeout(pending.timer);
    pending.resolve(result);
  }
}

// ============================================================
// ExecutionEnvironment (worker side)
// ============================================================

export interface CreatePollingExecutionEnvironmentOptions {
  queue: PullingTaskQueue;
  id?: string;
  displayName?: string;
  /** Default timeout for tasks (ms). Overridable per exec call via opts.timeout. */
  defaultTimeoutMs?: number;
  /** Override cwd resolution; defaults to scope.projectDir. */
  defaultCwd?: string;
}

export function createPollingExecutionEnvironment(
  options: CreatePollingExecutionEnvironmentOptions,
): ExecutionEnvironment {
  const queue = options.queue;
  const defaultTimeout = options.defaultTimeoutMs ?? 60_000;

  const resolveCwd = (scope: AgentScope, requested: string): string => {
    if (requested) return requested;
    if (options.defaultCwd) return options.defaultCwd;
    return scope.projectDir;
  };

  return createExecutionEnvironment({
    id: options.id ?? 'polling',
    kind: 'remote',
    displayName: options.displayName ?? 'Polling executor',
    isolationPolicy: (scope) => isolationPolicyFromScope(scope, { network: 'allow' }),
    createCommandExecutor: (scope): CommandExecutor => ({
      async exec(command, opts) {
        const task = pullingTaskRequestSchema.parse({
          taskId: randomBytes(8).toString('hex'),
          command,
          cwd: resolveCwd(scope, opts.cwd),
          env: stringifyEnv(opts.env),
          timeoutMs: opts.timeout ?? defaultTimeout,
        });
        const result = await queue.enqueue(task);
        return { output: result.output, isError: result.isError } satisfies ExecResult;
      },
      spawn(_command, _opts): ProcessHandle {
        throw new Error(
          'PollingExecutionEnvironment does not support spawn(); '
          + 'streaming long-running processes requires a bidirectional transport. '
          + 'Use createRemoteExecutionEnvironment with a WebSocket transport instead.',
        );
      },
    }),
  });
}

export function createPollingExecutionEnvironmentProvider(
  factory: (
    request: ExecutionEnvironmentProvisionRequest,
  ) => CreatePollingExecutionEnvironmentOptions | Promise<CreatePollingExecutionEnvironmentOptions>,
): ExecutionEnvironmentProvider {
  return {
    async provision(request) {
      const options = await factory(request);
      return createPollingExecutionEnvironment(options);
    },
  };
}

// ============================================================
// Executor agent helper (executor-host side)
// ============================================================
// Runs a poll loop against any PullingTaskSource. The actual command
// execution is supplied by the caller — typically a NodeExecutor in
// the remote host.

export interface PollingExecutorAgentOptions {
  source: PullingTaskSource;
  /** Block-poll timeout per request. Default 30s. */
  pollTimeoutMs?: number;
  /** Caller-supplied executor (e.g. NodeExecutor) that actually runs the task. */
  execute: (task: PullingTaskRequest) => Promise<PullingTaskResult>;
  /** Optional logger. */
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
}

/**
 * Long-running poll loop. Resolves when stop() is called.
 *
 * Errors during execute() are caught and surfaced as `{ isError: true }`
 * results so a single failing task doesn't tear down the agent.
 */
export class PollingExecutorAgent {
  private stopped = false;
  private stopWaker: (() => void) | null = null;
  private readonly options: PollingExecutorAgentOptions;

  constructor(options: PollingExecutorAgentOptions) {
    this.options = options;
  }

  async run(): Promise<void> {
    const timeout = this.options.pollTimeoutMs ?? 30_000;
    const logger = this.options.logger ?? console;
    while (!this.stopped) {
      try {
        // Race the source.poll(timeout) against an external "stop"
        // waker so stop() returns quickly even when poll is blocked.
        const stopPromise = new Promise<'__stop__'>((resolve) => {
          this.stopWaker = () => resolve('__stop__');
        });
        const winner = await Promise.race([
          this.options.source.poll(timeout),
          stopPromise,
        ]);
        this.stopWaker = null;
        if (winner === '__stop__' || this.stopped) break;
        const task = winner;
        if (!task) continue;
        let result: PullingTaskResult;
        try {
          result = await this.options.execute(task);
        } catch (err) {
          result = {
            taskId: task.taskId,
            output: err instanceof Error ? err.message : String(err),
            isError: true,
          };
        }
        await this.options.source.postResult(result);
      } catch (err) {
        logger.warn?.('[polling-executor] loop error:', err);
        // Small back-off so a misbehaving source doesn't hot-spin.
        await new Promise((r) => setTimeout(r, 1_000));
      }
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.stopWaker) {
      this.stopWaker();
      this.stopWaker = null;
    }
  }
}

function stringifyEnv(env: Record<string, string | undefined> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!env) return out;
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string') out[key] = value;
  }
  return out;
}
