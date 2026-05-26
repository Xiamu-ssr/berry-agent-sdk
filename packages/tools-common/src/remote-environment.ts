// ============================================================
// Berry Agent SDK — Remote Execution Environment
// ============================================================
// Wraps shell/process commands so they run on a remote worker reached over a
// transport contract. The default transport is `fetch` over HTTPS; tests and
// custom workers can supply their own RemoteTransport to keep the SDK free of
// transport assumptions.
//
// Wire format (default transport):
//   POST {endpoint}/exec
//     body: RemoteExecRequest
//     reply: RemoteExecReply
//   POST {endpoint}/spawn
//     body: RemoteSpawnRequest
//     reply: { runId }   then GET /streams/:runId yields SSE for stdout/exit.
//
// This file ships exec only by default. spawn is exposed but the default
// transport returns an error so hosts must wire a real streaming transport
// (WebSocket/SSE) to use background processes. Tests and product hosts can
// inject a transport that supports both.

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
import { z } from 'zod';

export const remoteExecRequestSchema = z.object({
  command: z.string().min(1),
  cwd: z.string().min(1),
  env: z.record(z.string()),
  timeoutMs: z.number().int().positive().optional(),
  maxBuffer: z.number().int().positive().optional(),
}).strict();

export const remoteExecReplySchema = z.object({
  output: z.string(),
  isError: z.boolean(),
}).strict();

export const remoteSpawnRequestSchema = remoteExecRequestSchema.pick({
  command: true,
  cwd: true,
  env: true,
});

export type RemoteExecRequest = z.infer<typeof remoteExecRequestSchema>;
export type RemoteExecReply = z.infer<typeof remoteExecReplySchema>;
export type RemoteSpawnRequest = z.infer<typeof remoteSpawnRequestSchema>;

export interface RemoteSpawnStream {
  /** Subscribe to stdout chunks. */
  onStdOut(handler: (chunk: string) => void): void;
  /** Subscribe to stderr chunks. */
  onStdErr(handler: (chunk: string) => void): void;
  /** Subscribe to exit notifications. */
  onExit(handler: (code: number | null, signal: string | null) => void): void;
  /** Subscribe to transport errors. */
  onError(handler: (error: Error) => void): void;
  /** Write to remote stdin. Returns once the chunk is acknowledged. */
  write(data: string): Promise<void>;
  /** Send a signal to the remote process. */
  kill(signal?: string): void;
  /** Whether the underlying transport is still accepting writes. */
  readonly stdinWritable: boolean;
  /** Remote pid if known. */
  readonly pid?: number;
}

export interface RemoteTransport {
  exec(request: RemoteExecRequest): Promise<RemoteExecReply>;
  /** Optional — when omitted, spawn() throws. */
  spawn?(request: RemoteSpawnRequest): RemoteSpawnStream;
  /** Optional cleanup at environment dispose time. */
  dispose?(): Promise<void> | void;
}

export interface CreateRemoteExecutionEnvironmentOptions {
  endpoint?: string;
  headers?: Record<string, string>;
  transport?: RemoteTransport;
  id?: string;
  displayName?: string;
  defaultCwd?: string;
  defaultTimeoutMs?: number;
}

const ENV_KIND = 'remote' as const;

export function createRemoteExecutionEnvironment(
  options: CreateRemoteExecutionEnvironmentOptions = {},
): ExecutionEnvironment {
  const transport = options.transport ?? createDefaultRemoteTransport(options);

  const resolveCwd = (scope: AgentScope, requestedCwd: string): string => {
    if (requestedCwd) return requestedCwd;
    if (options.defaultCwd) return options.defaultCwd;
    return scope.projectDir;
  };

  return createExecutionEnvironment({
    id: options.id ?? `remote:${options.endpoint ?? 'transport'}`,
    kind: ENV_KIND,
    displayName: options.displayName ?? 'Remote runner',
    isolationPolicy: (scope) => isolationPolicyFromScope(scope, { network: 'allow' }),
    createCommandExecutor: (scope) => ({
      async exec(command, opts) {
        const request = remoteExecRequestSchema.parse({
          command,
          cwd: resolveCwd(scope, opts.cwd),
          env: stringifyEnv(opts.env),
          timeoutMs: opts.timeout ?? options.defaultTimeoutMs,
          maxBuffer: opts.maxBuffer,
        });
        const reply = await transport.exec(request);
        return remoteExecReplySchema.parse(reply);
      },
      spawn(command, opts) {
        if (!transport.spawn) {
          throw new Error(
            'createRemoteExecutionEnvironment: the active transport does not implement spawn(); '
            + 'inject a transport that supports streaming before using background process tools.',
          );
        }
        const request = remoteSpawnRequestSchema.parse({
          command,
          cwd: resolveCwd(scope, opts.cwd),
          env: stringifyEnv(opts.env),
        });
        return adaptRemoteSpawn(transport.spawn(request));
      },
    } satisfies CommandExecutor),
    dispose: async () => {
      await transport.dispose?.();
    },
  });
}

export function createRemoteExecutionEnvironmentProvider(
  factory: (
    request: ExecutionEnvironmentProvisionRequest,
  ) => CreateRemoteExecutionEnvironmentOptions | Promise<CreateRemoteExecutionEnvironmentOptions>,
): ExecutionEnvironmentProvider {
  return {
    async provision(request) {
      const options = await factory(request);
      return createRemoteExecutionEnvironment(options);
    },
  };
}

// ============================================================
// Default fetch-based transport (exec only)
// ============================================================

interface DefaultRemoteTransportOptions {
  endpoint?: string;
  headers?: Record<string, string>;
}

export function createDefaultRemoteTransport(
  options: DefaultRemoteTransportOptions = {},
): RemoteTransport {
  const endpoint = options.endpoint;
  if (!endpoint) {
    return {
      async exec() {
        throw new Error(
          'createRemoteExecutionEnvironment: no endpoint configured. Pass either endpoint or a custom transport.',
        );
      },
    };
  }
  return {
    async exec(request) {
      const response = await fetch(`${endpoint.replace(/\/$/, '')}/exec`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(options.headers ?? {}) },
        body: JSON.stringify(request),
      });
      if (!response.ok) {
        const text = await safeReadBody(response);
        return { output: `${response.status} ${response.statusText}: ${text}`, isError: true };
      }
      const body = (await response.json()) as unknown;
      return remoteExecReplySchema.parse(body);
    },
  };
}

function stringifyEnv(env: Record<string, string | undefined> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!env) return out;
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string') out[key] = value;
  }
  return out;
}

async function safeReadBody(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 1024);
  } catch {
    return '<unreadable response body>';
  }
}

function adaptRemoteSpawn(stream: RemoteSpawnStream): ProcessHandle {
  return {
    get pid() { return stream.pid; },
    write: (data) => stream.write(data),
    kill: (signal) => stream.kill(signal),
    onStdOut: (handler) => stream.onStdOut(handler),
    onStdErr: (handler) => stream.onStdErr(handler),
    onError: (handler) => stream.onError(handler),
    onExit: (handler) => stream.onExit(handler),
    get stdinWritable() { return stream.stdinWritable; },
  };
}
