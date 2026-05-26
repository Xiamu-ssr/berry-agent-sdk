// ============================================================
// Berry Agent SDK — Container Execution Environment
// ============================================================
// Wraps shell/process commands so they run inside a container (e.g. Docker).
// Hosts can supply any container driver matching the small `ContainerDriver`
// contract; the default driver shells out to `docker` so consumers do not need
// a container library dependency in the published SDK.
//
// Lifecycle:
//   - provision   : ensure the container is running (start or reuse by id)
//   - exec        : `docker exec` (or driver equivalent) per command
//   - spawn       : streaming `docker exec` for background process hands
//   - dispose     : stop+remove the container only if the SDK created it
//
// All path policy decisions stay with the host (the caller decides what gets
// volume-mounted). The SDK keeps the brain/hands boundary: the model never
// sees container plumbing, only Hand-level tool calls.

import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import type {
  CommandExecutor,
  ExecOptions,
  ExecResult,
  ProcessHandle,
  SpawnOptions,
} from '@berry-agent/core';
import {
  createExecutionEnvironment,
  isolationPolicyFromScope,
  type AgentScope,
  type ExecutionEnvironment,
  type ExecutionEnvironmentProvider,
  type ExecutionEnvironmentProvisionRequest,
} from '@berry-agent/core';

export interface ContainerVolumeMount {
  hostPath: string;
  containerPath: string;
  readOnly?: boolean;
}

export interface ContainerExecConfig {
  containerId: string;
  command: string;
  cwd: string;
  env: Record<string, string | undefined>;
  timeoutMs?: number;
  maxBuffer?: number;
}

export interface ContainerSpawnConfig {
  containerId: string;
  command: string;
  cwd: string;
  env: Record<string, string | undefined>;
}

export interface ContainerStartConfig {
  image: string;
  workspaceMount: ContainerVolumeMount;
  extraMounts?: ContainerVolumeMount[];
  network?: 'none' | 'bridge' | 'host' | { name: string };
  user?: string;
  hostname?: string;
  labels?: Record<string, string>;
}

export interface ContainerSpawnHandle {
  pid: number | undefined;
  child: ChildProcess;
}

export interface ContainerDriver {
  /** Start a fresh container and return its id. */
  start(config: ContainerStartConfig): Promise<string>;
  /** Run a single command, capture combined output. */
  exec(config: ContainerExecConfig): Promise<ExecResult>;
  /** Start a long-lived command, return a Node ChildProcess-like handle. */
  spawn(config: ContainerSpawnConfig): ContainerSpawnHandle;
  /** Stop and remove a container the SDK started. Should be idempotent. */
  stop(containerId: string): Promise<void>;
}

export interface CreateContainerExecutionEnvironmentOptions {
  /** Image to run when the SDK starts the container. */
  image?: string;
  /** Reuse an existing container instead of starting one. Disables auto-stop. */
  containerId?: string;
  /** Where the agent workspace lives on the host vs inside the container. */
  workspaceMount?: ContainerVolumeMount;
  /** Extra read-only/read-write mounts (e.g. tool runtimes). */
  extraMounts?: ContainerVolumeMount[];
  network?: ContainerStartConfig['network'];
  user?: string;
  /** Override the default `docker` driver — used by tests and non-docker runners. */
  driver?: ContainerDriver;
  /** Stable id and display name for the resulting environment. */
  id?: string;
  displayName?: string;
  /** Stable labels written by the default driver. */
  labels?: Record<string, string>;
  /** Optional override of the cwd inside the container. */
  defaultCwd?: string;
}

const ENV_KIND = 'container' as const;

export function createContainerExecutionEnvironment(
  options: CreateContainerExecutionEnvironmentOptions = {},
): ExecutionEnvironment {
  const driver = options.driver ?? createDefaultDockerDriver();
  const ownsContainer = !options.containerId;
  let containerId: string | undefined = options.containerId;
  let starting: Promise<string> | undefined;

  const ensureContainer = async (): Promise<string> => {
    if (containerId) return containerId;
    if (starting) return starting;
    if (!options.image) {
      throw new Error('createContainerExecutionEnvironment: image is required when containerId is not supplied');
    }
    if (!options.workspaceMount) {
      throw new Error('createContainerExecutionEnvironment: workspaceMount is required when starting a new container');
    }
    starting = driver.start({
      image: options.image,
      workspaceMount: options.workspaceMount,
      extraMounts: options.extraMounts,
      network: options.network,
      user: options.user,
      labels: options.labels,
    });
    try {
      containerId = await starting;
      return containerId;
    } finally {
      starting = undefined;
    }
  };

  const resolveCwd = (scope: AgentScope): string => {
    if (options.defaultCwd) return options.defaultCwd;
    if (options.workspaceMount) return options.workspaceMount.containerPath;
    return scope.projectDir;
  };

  return createExecutionEnvironment({
    id: options.id ?? `container:${options.containerId ?? options.image ?? 'unspecified'}`,
    kind: ENV_KIND,
    displayName: options.displayName ?? 'Container',
    isolationPolicy: (scope) => isolationPolicyFromScope(scope),
    createCommandExecutor: (scope) => ({
      async exec(command, opts) {
        const id = await ensureContainer();
        return driver.exec({
          containerId: id,
          command,
          cwd: opts.cwd || resolveCwd(scope),
          env: opts.env ?? {},
          timeoutMs: opts.timeout,
          maxBuffer: opts.maxBuffer,
        });
      },
      spawn(command, opts) {
        if (!containerId) {
          throw new Error('Container is not ready yet; await an exec() call before spawning long-lived processes.');
        }
        const handle = driver.spawn({
          containerId,
          command,
          cwd: opts.cwd || resolveCwd(scope),
          env: opts.env ?? {},
        });
        return adaptSpawnHandle(handle);
      },
    } satisfies CommandExecutor),
    dispose: async () => {
      if (!ownsContainer || !containerId) return;
      const id = containerId;
      containerId = undefined;
      await driver.stop(id);
    },
  });
}

export function createContainerExecutionEnvironmentProvider(
  factory: (
    request: ExecutionEnvironmentProvisionRequest,
  ) => CreateContainerExecutionEnvironmentOptions | Promise<CreateContainerExecutionEnvironmentOptions>,
): ExecutionEnvironmentProvider {
  return {
    async provision(request) {
      const options = await factory(request);
      return createContainerExecutionEnvironment(options);
    },
  };
}

// ============================================================
// Default Docker driver
// ============================================================

interface DockerDriverOptions {
  binary?: string;
}

export function createDefaultDockerDriver(options: DockerDriverOptions = {}): ContainerDriver {
  const binary = options.binary ?? 'docker';
  return {
    async start(config) {
      const args = [
        'run',
        '-d',
        '--rm',
        '--init',
        '--workdir', config.workspaceMount.containerPath,
        '-v', formatMount(config.workspaceMount),
        ...(config.extraMounts?.flatMap((mount) => ['-v', formatMount(mount)]) ?? []),
        ...formatNetworkArgs(config.network),
        ...(config.user ? ['--user', config.user] : []),
        ...(config.hostname ? ['--hostname', config.hostname] : []),
        ...formatLabelArgs(config.labels),
        config.image,
        'sleep', 'infinity',
      ];
      const result = await runOnce(binary, args);
      if (result.isError) {
        throw new Error(`docker run failed: ${result.output.trim()}`);
      }
      return result.output.trim();
    },
    async exec(config) {
      const env = sanitizeEnv(config.env);
      const args = [
        'exec',
        '--workdir', config.cwd,
        ...Object.entries(env).flatMap(([key, value]) => ['-e', `${key}=${value}`]),
        config.containerId,
        'sh', '-c', config.command,
      ];
      return runOnce(binary, args, {
        timeoutMs: config.timeoutMs,
        maxBuffer: config.maxBuffer ?? 1024 * 1024,
      });
    },
    spawn(config) {
      const env = sanitizeEnv(config.env);
      const args = [
        'exec',
        '--workdir', config.cwd,
        '-i',
        ...Object.entries(env).flatMap(([key, value]) => ['-e', `${key}=${value}`]),
        config.containerId,
        'sh', '-c', config.command,
      ];
      const child = nodeSpawn(binary, args, { stdio: ['pipe', 'pipe', 'pipe'] });
      return { pid: child.pid, child };
    },
    async stop(containerId) {
      try {
        await runOnce(binary, ['rm', '-f', containerId]);
      } catch {
        // Best-effort: container may already be gone.
      }
    },
  };
}

function formatMount(mount: ContainerVolumeMount): string {
  const suffix = mount.readOnly ? ':ro' : '';
  return `${mount.hostPath}:${mount.containerPath}${suffix}`;
}

function formatNetworkArgs(network: ContainerStartConfig['network']): string[] {
  if (!network) return [];
  if (typeof network === 'string') return ['--network', network];
  return ['--network', network.name];
}

function formatLabelArgs(labels: Record<string, string> | undefined): string[] {
  if (!labels) return [];
  return Object.entries(labels).flatMap(([key, value]) => ['--label', `${key}=${value}`]);
}

function sanitizeEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string') out[key] = value;
  }
  return out;
}

async function runOnce(
  binary: string,
  args: string[],
  options: { timeoutMs?: number; maxBuffer?: number } = {},
): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = nodeSpawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const max = options.maxBuffer ?? 1024 * 1024;
    let output = '';
    let truncated = false;
    let timer: NodeJS.Timeout | undefined;

    const append = (chunk: Buffer | string): void => {
      if (truncated) return;
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
      if (output.length + text.length > max) {
        output += text.slice(0, max - output.length);
        truncated = true;
      } else {
        output += text;
      }
    };

    child.stdout?.on('data', append);
    child.stderr?.on('data', append);

    if (options.timeoutMs && options.timeoutMs > 0) {
      timer = setTimeout(() => {
        child.kill('SIGKILL');
      }, options.timeoutMs);
    }

    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      resolve({ output: `${output}\n${err.message}`.trim(), isError: true });
    });
    child.on('exit', (code, signal) => {
      if (timer) clearTimeout(timer);
      const isError = code !== 0 || !!signal;
      resolve({ output: truncated ? `${output}\n[truncated]` : output, isError });
    });
  });
}

function adaptSpawnHandle(handle: ContainerSpawnHandle): ProcessHandle {
  const { child } = handle;
  let stdoutHandlers: ((chunk: string) => void)[] = [];
  let stderrHandlers: ((chunk: string) => void)[] = [];
  let errorHandlers: ((err: Error) => void)[] = [];
  let exitHandlers: ((code: number | null, signal: string | null) => void)[] = [];

  child.stdout?.on('data', (chunk) => {
    const text = chunk.toString('utf-8');
    for (const handler of stdoutHandlers) handler(text);
  });
  child.stderr?.on('data', (chunk) => {
    const text = chunk.toString('utf-8');
    for (const handler of stderrHandlers) handler(text);
  });
  child.on('error', (err) => {
    for (const handler of errorHandlers) handler(err);
  });
  child.on('exit', (code, signal) => {
    for (const handler of exitHandlers) handler(code, signal);
  });

  return {
    pid: handle.pid,
    write: async (data) => {
      if (!child.stdin?.writable) return;
      await new Promise<void>((resolve, reject) => {
        child.stdin!.write(data, (err) => (err ? reject(err) : resolve()));
      });
    },
    kill: (signal) => {
      child.kill((signal as NodeJS.Signals) ?? 'SIGTERM');
    },
    onStdOut: (handler) => { stdoutHandlers.push(handler); },
    onStdErr: (handler) => { stderrHandlers.push(handler); },
    onError: (handler) => { errorHandlers.push(handler); },
    onExit: (handler) => { exitHandlers.push(handler); },
    get stdinWritable() { return !!child.stdin?.writable; },
  };
}
