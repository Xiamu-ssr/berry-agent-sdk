// ============================================================
// @berry-agent/runtime — Orchestration Store
// ============================================================
// Memory / file-backed implementations of RuntimeOrchestrationStore, the
// JSON parser, and snapshot helpers. Kept separate from the orchestrator
// class so alternative stores (S3, Postgres, Redis) can be added without
// touching state-machine logic.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { ZodError, type ZodIssue, type z } from 'zod';
import {
  RUNTIME_ORCHESTRATION_FILENAME,
  type RuntimeOrchestrationSnapshot,
  zRuntimeOrchestrationSnapshot,
} from './orchestration-schemas.js';

export interface RuntimeOrchestrationStore {
  load(): Promise<RuntimeOrchestrationSnapshot>;
  save(snapshot: RuntimeOrchestrationSnapshot): Promise<void>;
}

export class MemoryRuntimeOrchestrationStore implements RuntimeOrchestrationStore {
  private snapshot: RuntimeOrchestrationSnapshot = emptySnapshot();

  async load(): Promise<RuntimeOrchestrationSnapshot> {
    return cloneSnapshot(this.snapshot);
  }

  async save(snapshot: RuntimeOrchestrationSnapshot): Promise<void> {
    this.snapshot = cloneSnapshot(snapshot);
  }
}

export class FileRuntimeOrchestrationStore implements RuntimeOrchestrationStore {
  constructor(private readonly filePath: string) {}

  async load(): Promise<RuntimeOrchestrationSnapshot> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, 'utf-8');
    } catch (error) {
      if (isNotFoundError(error)) return emptySnapshot();
      throw error;
    }
    return parseRuntimeOrchestrationSnapshot(raw, this.filePath);
  }

  async save(snapshot: RuntimeOrchestrationSnapshot): Promise<void> {
    const parsed = parseSchema(zRuntimeOrchestrationSnapshot, snapshot, this.filePath);
    await mkdir(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    await writeFile(tmp, `${JSON.stringify(parsed, null, 2)}\n`, 'utf-8');
    await rename(tmp, this.filePath);
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
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Failed to parse ${source}: ${error instanceof Error ? error.message : String(error)}`);
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

export function parseSchema<T>(schema: z.ZodType<T>, value: unknown, source: string): T {
  try {
    return schema.parse(value);
  } catch (error) {
    if (error instanceof ZodError) {
      const issue = error.issues[0];
      throw new Error(`Invalid ${formatIssuePath(source, issue?.path ?? [])}: ${formatIssueMessage(issue)}`);
    }
    throw error;
  }
}

function isNotFoundError(error: unknown): boolean {
  return !!error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT';
}

function formatIssuePath(source: string, path: Array<string | number>): string {
  return path.reduce<string>((out, part) => (
    typeof part === 'number' ? `${out}[${part}]` : `${out}.${part}`
  ), source);
}

function formatIssueMessage(issue: ZodIssue | undefined): string {
  if (!issue) return 'invalid value';
  return issue.message;
}
