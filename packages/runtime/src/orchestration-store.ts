// ============================================================
// @berry-agent/runtime — Orchestration Store
// ============================================================
// Memory / file-backed implementations of RuntimeOrchestrationStore, the
// JSON parser, and snapshot helpers. Kept separate from the orchestrator
// class so alternative stores (S3, Postgres, Redis) can be added without
// touching state-machine logic.
//
// Concurrency model:
//   Stores expose `transact(mutator)` as the only safe write path.
//   `transact` must observe one snapshot, apply the mutator, and commit
//   the returned snapshot atomically with respect to other concurrent
//   transactions. Backends with native transactions (SQLite, Postgres)
//   wrap the body in `BEGIN ... COMMIT`; in-process backends serialize
//   transactions through a mutex.
//
//   `load()` is still exposed for read-only callers (e.g. observability),
//   but every mutator must go through `transact`. `save()` is intentionally
//   absent — there is no safe naked save.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  errorMessage,
  isNoEntryError,
  parseSchema,
  writeJsonAtomic,
} from '@berry-agent/core';
import {
  RUNTIME_ORCHESTRATION_FILENAME,
  type RuntimeOrchestrationSnapshot,
  zRuntimeOrchestrationSnapshot,
} from './orchestration-schemas.js';

/**
 * Mutator passed to RuntimeOrchestrationStore.transact. Receives the
 * current snapshot, may return any value alongside the next snapshot.
 * If the mutator throws, the transaction must be rolled back.
 */
export type RuntimeOrchestrationMutator<TResult> = (
  snapshot: RuntimeOrchestrationSnapshot,
) => RuntimeOrchestrationMutatorResult<TResult> | Promise<RuntimeOrchestrationMutatorResult<TResult>>;

export interface RuntimeOrchestrationMutatorResult<TResult> {
  /** Snapshot to persist. Must be the *next* state (mutator may mutate in place). */
  snapshot: RuntimeOrchestrationSnapshot;
  /** Value returned to the caller (e.g. the new lease, the claimed wakes). */
  result: TResult;
}

export interface RuntimeOrchestrationStore {
  /** Read the current snapshot without acquiring any lock. Suitable for
   *  observability — do not write back what you read here. */
  load(): Promise<RuntimeOrchestrationSnapshot>;
  /**
   * Run `mutator` in an isolated transaction. The store guarantees that
   * - the snapshot passed in is the current state at the start of the txn
   * - the snapshot returned is persisted before another transaction starts
   * - if the mutator throws, no changes land
   */
  transact<TResult>(mutator: RuntimeOrchestrationMutator<TResult>): Promise<TResult>;
}

// ----- Memory implementation (mutex-serialized) -----

export class MemoryRuntimeOrchestrationStore implements RuntimeOrchestrationStore {
  private snapshot: RuntimeOrchestrationSnapshot = emptySnapshot();
  private chain: Promise<unknown> = Promise.resolve();

  async load(): Promise<RuntimeOrchestrationSnapshot> {
    return cloneSnapshot(this.snapshot);
  }

  transact<TResult>(mutator: RuntimeOrchestrationMutator<TResult>): Promise<TResult> {
    const run = this.chain.then(async () => {
      const working = cloneSnapshot(this.snapshot);
      const { snapshot: next, result } = await mutator(working);
      this.snapshot = cloneSnapshot(next);
      return result;
    });
    // Keep the chain alive but suppress upstream rejections so one
    // failed transaction does not poison subsequent ones.
    this.chain = run.catch(() => undefined);
    return run;
  }
}

// ----- File implementation (in-process mutex; OK for single-process hosts) -----

export class FileRuntimeOrchestrationStore implements RuntimeOrchestrationStore {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async load(): Promise<RuntimeOrchestrationSnapshot> {
    return this.readSnapshot();
  }

  transact<TResult>(mutator: RuntimeOrchestrationMutator<TResult>): Promise<TResult> {
    const run = this.chain.then(async () => {
      const working = await this.readSnapshot();
      const { snapshot: next, result } = await mutator(working);
      await this.writeSnapshot(next);
      return result;
    });
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async readSnapshot(): Promise<RuntimeOrchestrationSnapshot> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, 'utf-8');
    } catch (error) {
      if (isNoEntryError(error)) return emptySnapshot();
      throw error;
    }
    return parseRuntimeOrchestrationSnapshot(raw, this.filePath);
  }

  private async writeSnapshot(snapshot: RuntimeOrchestrationSnapshot): Promise<void> {
    const parsed = parseSchema(zRuntimeOrchestrationSnapshot, snapshot, this.filePath);
    await writeJsonAtomic(this.filePath, parsed, { trailingNewline: true });
  }
}

export function runtimeOrchestrationPath(rootDir: string): string {
  if (!rootDir) throw new Error('rootDir is required');
  return join(rootDir, RUNTIME_ORCHESTRATION_FILENAME);
}

export function createFileRuntimeOrchestrationStore(rootDir: string): FileRuntimeOrchestrationStore {
  return new FileRuntimeOrchestrationStore(runtimeOrchestrationPath(rootDir));
}

export function parseRuntimeOrchestrationSnapshot(
  raw: string,
  source = 'runtime orchestration snapshot',
): RuntimeOrchestrationSnapshot {
  // Migrate older snapshots that predate `workers[]` by injecting an empty
  // array between JSON.parse and zod validation. parseJsonWithSchema can't
  // host this peek, so we open-code the JSON layer here.
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Failed to parse ${source}: ${errorMessage(error)}`);
  }
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && !('workers' in parsed)) {
    (parsed as Record<string, unknown>).workers = [];
  }
  return parseSchema(zRuntimeOrchestrationSnapshot, parsed, source);
}

export function emptySnapshot(): RuntimeOrchestrationSnapshot {
  return { leases: [], wakes: [], workers: [] };
}

export function cloneSnapshot(snapshot: RuntimeOrchestrationSnapshot): RuntimeOrchestrationSnapshot {
  return parseSchema(zRuntimeOrchestrationSnapshot, structuredClone(snapshot), 'runtime orchestration snapshot');
}

