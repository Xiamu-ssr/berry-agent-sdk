// ============================================================
// @berry-agent/runtime-sqlite — SQLite RuntimeOrchestrationStore
// ============================================================
// Multi-process-safe alternative to FileRuntimeOrchestrationStore for
// single-machine deployments that run several workers. WAL mode + a
// BEGIN IMMEDIATE wrapper around every save means concurrent worker
// processes serialize cleanly on the same DB file.
//
// For cross-machine deployments (the "几十台云" scenario), use a network-
// reachable store backend (Postgres recommended) instead.

import Database, { type Database as BetterSqliteDB } from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  parseRuntimeOrchestrationSnapshot,
  type RuntimeOrchestrationSnapshot,
  type RuntimeOrchestrationStore,
} from '@berry-agent/runtime';

const EMPTY_SNAPSHOT: RuntimeOrchestrationSnapshot = { leases: [], wakes: [], workers: [] };

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS runtime_orchestration (
    id TEXT PRIMARY KEY DEFAULT 'singleton',
    snapshot TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
`;

const INIT_ROW_SQL = `
  INSERT OR IGNORE INTO runtime_orchestration (id, snapshot, updated_at)
  VALUES ('singleton', ?, ?);
`;

const SELECT_SQL = `SELECT snapshot FROM runtime_orchestration WHERE id = 'singleton';`;
const UPDATE_SQL = `UPDATE runtime_orchestration SET snapshot = ?, updated_at = ? WHERE id = 'singleton';`;

export interface SqliteRuntimeOrchestrationStoreOptions {
  /** Path to the SQLite database file. Use ':memory:' for tests. */
  dbPath: string;
  /** Pragma `busy_timeout` in milliseconds. Defaults to 5_000. */
  busyTimeoutMs?: number;
  /** Set to false to skip pragma `journal_mode = WAL`. */
  walMode?: boolean;
}

/**
 * SQLite-backed RuntimeOrchestrationStore. Holds the orchestration
 * snapshot in a single row; every save() runs inside an IMMEDIATE
 * transaction so concurrent workers can compete safely on lease/wake/worker
 * updates.
 *
 * Storage shape (single-row, single-table):
 *   - id = 'singleton'
 *   - snapshot = JSON.stringify(RuntimeOrchestrationSnapshot)
 *   - updated_at = epoch ms
 *
 * Schema migration is idempotent — call ensureSchema() once at startup,
 * or pass autoMigrate: true to the constructor (default).
 */
export class SqliteRuntimeOrchestrationStore implements RuntimeOrchestrationStore {
  private readonly db: BetterSqliteDB;
  private readonly selectStmt: Database.Statement;
  private readonly updateStmt: Database.Statement;

  constructor(options: SqliteRuntimeOrchestrationStoreOptions) {
    if (!options.dbPath) throw new Error('dbPath is required');

    if (options.dbPath !== ':memory:') {
      mkdirSync(dirname(options.dbPath), { recursive: true });
    }

    this.db = new Database(options.dbPath);
    if (options.walMode !== false && options.dbPath !== ':memory:') {
      this.db.pragma('journal_mode = WAL');
    }
    this.db.pragma(`busy_timeout = ${options.busyTimeoutMs ?? 5_000}`);
    this.db.pragma('synchronous = NORMAL');
    this.ensureSchema();

    this.selectStmt = this.db.prepare(SELECT_SQL);
    this.updateStmt = this.db.prepare(UPDATE_SQL);
  }

  ensureSchema(): void {
    this.db.exec(SCHEMA_SQL);
    const now = Date.now();
    this.db.prepare(INIT_ROW_SQL).run(JSON.stringify(EMPTY_SNAPSHOT), now);
  }

  async load(): Promise<RuntimeOrchestrationSnapshot> {
    const row = this.selectStmt.get() as { snapshot: string } | undefined;
    if (!row) return { leases: [], wakes: [], workers: [] };
    return parseRuntimeOrchestrationSnapshot(row.snapshot, 'sqlite runtime orchestration snapshot');
  }

  async save(snapshot: RuntimeOrchestrationSnapshot): Promise<void> {
    const serialized = JSON.stringify(snapshot);
    const now = Date.now();
    const tx = this.db.transaction(() => {
      this.updateStmt.run(serialized, now);
    });
    tx.immediate();
  }

  /** Close the underlying DB handle. Tests + graceful shutdown only. */
  close(): void {
    this.db.close();
  }
}

export function createSqliteRuntimeOrchestrationStore(
  options: SqliteRuntimeOrchestrationStoreOptions,
): SqliteRuntimeOrchestrationStore {
  return new SqliteRuntimeOrchestrationStore(options);
}
