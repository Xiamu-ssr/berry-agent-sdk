// ============================================================
// Berry Agent SDK — Execution Environment Boundary
// ============================================================
//
// The harness owns agent semantics; environments own where hands run.
// A host product can provide a local process, OS sandbox, container, or
// remote runner without changing model-visible tools or session semantics.

import type { CommandExecutor } from './executor.js';
import type { Hand } from './hands.js';
import type { AgentScope } from './scope.js';

export type ExecutionEnvironmentKind =
  | 'local-process'
  | 'os-sandbox'
  | 'container'
  | 'remote'
  | (string & {});

export type ExecutionEnvironmentState =
  | 'idle'
  | 'provisioning'
  | 'ready'
  | 'busy'
  | 'failed'
  | 'disposed';

export type ExecutionNetworkPolicy = 'allow' | 'deny' | { allowDomains: string[] };

export interface WorkspaceBinding {
  /** Agent-private durable root. */
  workspace: string;
  /** Optional codebase or product-selected working root. */
  project: string | null;
  /** Default command cwd. */
  cwd: string;
  /** Informational read roots. Some environments may still allow broader reads. */
  readableRoots: string[];
  /** The only roots where write-capable hands should mutate files. */
  writableRoots: string[];
}

export interface ExecutionIsolationPolicy {
  allowRead: string[];
  allowWrite: string[];
  denyPaths?: string[];
  network: ExecutionNetworkPolicy;
  allowExec?: boolean;
}

export interface ScopeIsolationOptions {
  /** Extra readable paths needed by a concrete runner, such as tool runtimes. */
  extraRead?: string[];
  /** Extra writable scratch paths. Defaults to `/tmp`. */
  extraWrite?: string[];
  denyPaths?: string[];
  network?: ExecutionNetworkPolicy;
  allowExec?: boolean;
}

export interface ExecutionEnvironmentStatus {
  id: string;
  kind: ExecutionEnvironmentKind;
  displayName?: string;
  state: ExecutionEnvironmentState;
  detail?: string;
}

export interface ExecutionEnvironmentProvisionRequest {
  agentId: string;
  scope: AgentScope;
  binding: WorkspaceBinding;
  isolationPolicy: ExecutionIsolationPolicy;
}

export interface ExecutionEnvironmentProvider {
  provision(
    request: ExecutionEnvironmentProvisionRequest,
  ): ExecutionEnvironment | Promise<ExecutionEnvironment | undefined> | undefined;
}

export interface ExecutionEnvironment {
  readonly id: string;
  readonly kind: ExecutionEnvironmentKind;
  readonly displayName?: string;

  /**
   * Return a command executor for shell/process hands. A container or remote
   * implementation can hide transport details behind this executor.
   */
  createCommandExecutor?(scope: AgentScope): CommandExecutor | null;

  /**
   * Optional extra hands provisioned by the environment, for example browser
   * automation or a remote file bridge.
   */
  createHands?(scope: AgentScope): readonly Hand[];

  isolationPolicy?(scope: AgentScope): ExecutionIsolationPolicy;
  status?(): ExecutionEnvironmentStatus;
  dispose?(): Promise<void> | void;
}

export interface CreateExecutionEnvironmentOptions {
  id: string;
  kind: ExecutionEnvironmentKind;
  displayName?: string;
  state?: ExecutionEnvironmentState;
  createCommandExecutor?: (scope: AgentScope) => CommandExecutor | null;
  createHands?: (scope: AgentScope) => readonly Hand[];
  isolationPolicy?: (scope: AgentScope) => ExecutionIsolationPolicy;
  dispose?: () => Promise<void> | void;
}

export function workspaceBindingFromScope(scope: AgentScope): WorkspaceBinding {
  return {
    workspace: scope.workspace,
    project: scope.project,
    cwd: scope.projectDir,
    readableRoots: scope.readableRoots,
    writableRoots: scope.writableRoots,
  };
}

export function isolationPolicyFromScope(
  scope: AgentScope,
  options: ScopeIsolationOptions = {},
): ExecutionIsolationPolicy {
  const extraWrite = options.extraWrite ?? ['/tmp'];
  const policy: ExecutionIsolationPolicy = {
    allowRead: [...scope.readableRoots, ...(options.extraRead ?? [])],
    allowWrite: [...scope.writableRoots, ...extraWrite],
    network: options.network ?? 'allow',
    allowExec: options.allowExec ?? true,
  };
  if (options.denyPaths?.length) policy.denyPaths = options.denyPaths;
  return policy;
}

export function createExecutionEnvironment(
  options: CreateExecutionEnvironmentOptions,
): ExecutionEnvironment {
  let state = options.state ?? 'ready';
  return {
    id: options.id,
    kind: options.kind,
    displayName: options.displayName,
    createCommandExecutor: options.createCommandExecutor,
    createHands: options.createHands,
    isolationPolicy: options.isolationPolicy,
    status: () => ({
      id: options.id,
      kind: options.kind,
      displayName: options.displayName,
      state,
    }),
    dispose: async () => {
      await options.dispose?.();
      state = 'disposed';
    },
  };
}

export class ExecutionEnvironmentRegistry {
  private readonly environments = new Map<string, ExecutionEnvironment>();

  register(environment: ExecutionEnvironment): void {
    if (this.environments.has(environment.id)) {
      throw new Error(`Execution environment already registered: ${environment.id}`);
    }
    this.environments.set(environment.id, environment);
  }

  async replace(environment: ExecutionEnvironment): Promise<ExecutionEnvironment | undefined> {
    const existing = this.environments.get(environment.id);
    if (existing) {
      await disposeEnvironment(existing);
    }
    this.environments.set(environment.id, environment);
    return existing;
  }

  unregister(id: string): ExecutionEnvironment | undefined {
    const environment = this.environments.get(id);
    this.environments.delete(id);
    return environment;
  }

  async drop(id: string): Promise<boolean> {
    const environment = this.environments.get(id);
    if (!environment) return false;
    await disposeEnvironment(environment);
    this.environments.delete(id);
    return true;
  }

  get(id: string): ExecutionEnvironment | undefined {
    return this.environments.get(id);
  }

  list(): ExecutionEnvironment[] {
    return [...this.environments.values()];
  }

  statuses(): ExecutionEnvironmentStatus[] {
    return this.list().map((environment) => environment.status?.() ?? ({
      id: environment.id,
      kind: environment.kind,
      displayName: environment.displayName,
      state: 'ready',
    }));
  }

  async disposeAll(): Promise<void> {
    const results = await Promise.allSettled(this.list().map(disposeEnvironment));
    this.environments.clear();
    const rejected = results.find((result) => result.status === 'rejected');
    if (rejected) throw rejected.reason;
  }
}

async function disposeEnvironment(environment: ExecutionEnvironment): Promise<void> {
  await environment.dispose?.();
}
