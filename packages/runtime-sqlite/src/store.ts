// ============================================================
// @berry-agent/runtime-sqlite — SQLite RuntimeOrchestrationStore
// ============================================================
// Multi-process-safe RuntimeOrchestrationStore for single-machine
// deployments that run several worker processes against the same
// orchestration state. WAL mode + a BEGIN IMMEDIATE wrapper around
// every transact() means concurrent processes serialize cleanly on
// the same DB file.
//
// For cross-machine deployments (the "几十台云" scenario), use a
// network-reachable store backend (Postgres recommended) instead.
//
// Schema model:
//   - Three normalized tables — runtime_leases / runtime_wakes /
//     runtime_workers — keyed on the entity's primary id.
//   - load() / transact() assemble a RuntimeOrchestrationSnapshot
//     from row reads and apply diff-based writes inside one
//     transaction so unchanged rows aren't rewritten on every mutation.
//
// Concurrency model:
//   - load(): read all three tables, no lock.
//   - transact(mutator):
//       BEGIN IMMEDIATE
//         → SELECT all rows
//         → assemble snapshot
//         → run mutator (may be async — better-sqlite3 is sync, so we
//           manually emit BEGIN/COMMIT and bridge the async mutator)
//         → diff old vs new and emit minimal INSERT/UPDATE/DELETE
//       COMMIT (or ROLLBACK on error)
//   IMMEDIATE acquires the database's RESERVED lock at the start of the
//   transaction, so two processes never observe the same snapshot
//   mid-mutate; the loser blocks until the winner commits (subject to
//   busy_timeout).

import Database, { type Database as BetterSqliteDB } from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  type RuntimeLease,
  type RuntimeOrchestrationMutator,
  type RuntimeOrchestrationSnapshot,
  type RuntimeOrchestrationStore,
  type RuntimeWake,
  type RuntimeWorker,
} from '@berry-agent/runtime';

// ------------------------------------------------------------
// Schema
// ------------------------------------------------------------

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS runtime_leases (
    leaseId TEXT PRIMARY KEY,
    agentId TEXT NOT NULL,
    holderId TEXT NOT NULL,
    workerId TEXT,
    sessionId TEXT,
    state TEXT NOT NULL CHECK(state IN ('active','released','expired')),
    acquiredAt INTEGER NOT NULL,
    expiresAt INTEGER NOT NULL,
    renewedAt INTEGER,
    releasedAt INTEGER,
    expiredAt INTEGER,
    metadata_json TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_runtime_leases_agent ON runtime_leases (agentId);
  CREATE INDEX IF NOT EXISTS idx_runtime_leases_state ON runtime_leases (state);

  CREATE TABLE IF NOT EXISTS runtime_wakes (
    wakeId TEXT PRIMARY KEY,
    agentId TEXT NOT NULL,
    sessionId TEXT,
    reason TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('pending','claimed','completed','failed','cancelled')),
    createdAt INTEGER NOT NULL,
    dueAt INTEGER NOT NULL,
    claimedAt INTEGER,
    claimAttempts INTEGER,
    completedAt INTEGER,
    failedAt INTEGER,
    cancelledAt INTEGER,
    errorMessage TEXT,
    payload_json TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_runtime_wakes_state_due ON runtime_wakes (state, dueAt);

  CREATE TABLE IF NOT EXISTS runtime_workers (
    workerId TEXT PRIMARY KEY,
    holderId TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('active','draining','evicted','withdrawn')),
    capacity INTEGER NOT NULL,
    registeredAt INTEGER NOT NULL,
    heartbeatAt INTEGER NOT NULL,
    heartbeatExpiresAt INTEGER NOT NULL,
    drainedAt INTEGER,
    evictedAt INTEGER,
    withdrawnAt INTEGER,
    labels_json TEXT,
    metadata_json TEXT
  );

  -- Drop the legacy single-row JSON snapshot if it exists. The store
  -- never deployed past pre-release, so we can shed it cleanly instead
  -- of carrying a migration path.
  DROP TABLE IF EXISTS runtime_orchestration;
`;

// ------------------------------------------------------------
// Row <-> domain conversions
// ------------------------------------------------------------

interface LeaseRow {
  leaseId: string;
  agentId: string;
  holderId: string;
  workerId: string | null;
  sessionId: string | null;
  state: RuntimeLease['state'];
  acquiredAt: number;
  expiresAt: number;
  renewedAt: number | null;
  releasedAt: number | null;
  expiredAt: number | null;
  metadata_json: string | null;
}

interface WakeRow {
  wakeId: string;
  agentId: string;
  sessionId: string | null;
  reason: string;
  state: RuntimeWake['state'];
  createdAt: number;
  dueAt: number;
  claimedAt: number | null;
  claimAttempts: number | null;
  completedAt: number | null;
  failedAt: number | null;
  cancelledAt: number | null;
  errorMessage: string | null;
  payload_json: string | null;
}

interface WorkerRow {
  workerId: string;
  holderId: string;
  state: RuntimeWorker['state'];
  capacity: number;
  registeredAt: number;
  heartbeatAt: number;
  heartbeatExpiresAt: number;
  drainedAt: number | null;
  evictedAt: number | null;
  withdrawnAt: number | null;
  labels_json: string | null;
  metadata_json: string | null;
}

function rowToLease(r: LeaseRow): RuntimeLease {
  const lease: RuntimeLease = {
    leaseId: r.leaseId,
    agentId: r.agentId,
    holderId: r.holderId,
    state: r.state,
    acquiredAt: r.acquiredAt,
    expiresAt: r.expiresAt,
  };
  if (r.workerId !== null) lease.workerId = r.workerId;
  if (r.sessionId !== null) lease.sessionId = r.sessionId;
  if (r.renewedAt !== null) lease.renewedAt = r.renewedAt;
  if (r.releasedAt !== null) lease.releasedAt = r.releasedAt;
  if (r.expiredAt !== null) lease.expiredAt = r.expiredAt;
  if (r.metadata_json !== null) {
    lease.metadata = JSON.parse(r.metadata_json) as Record<string, unknown>;
  }
  return lease;
}

function rowToWake(r: WakeRow): RuntimeWake {
  const wake: RuntimeWake = {
    wakeId: r.wakeId,
    agentId: r.agentId,
    reason: r.reason,
    state: r.state,
    createdAt: r.createdAt,
    dueAt: r.dueAt,
  };
  if (r.sessionId !== null) wake.sessionId = r.sessionId;
  if (r.claimedAt !== null) wake.claimedAt = r.claimedAt;
  if (r.claimAttempts !== null) wake.claimAttempts = r.claimAttempts;
  if (r.completedAt !== null) wake.completedAt = r.completedAt;
  if (r.failedAt !== null) wake.failedAt = r.failedAt;
  if (r.cancelledAt !== null) wake.cancelledAt = r.cancelledAt;
  if (r.errorMessage !== null) wake.errorMessage = r.errorMessage;
  if (r.payload_json !== null) {
    wake.payload = JSON.parse(r.payload_json) as Record<string, unknown>;
  }
  return wake;
}

function rowToWorker(r: WorkerRow): RuntimeWorker {
  const worker: RuntimeWorker = {
    workerId: r.workerId,
    holderId: r.holderId,
    state: r.state,
    capacity: r.capacity,
    registeredAt: r.registeredAt,
    heartbeatAt: r.heartbeatAt,
    heartbeatExpiresAt: r.heartbeatExpiresAt,
  };
  if (r.drainedAt !== null) worker.drainedAt = r.drainedAt;
  if (r.evictedAt !== null) worker.evictedAt = r.evictedAt;
  if (r.withdrawnAt !== null) worker.withdrawnAt = r.withdrawnAt;
  if (r.labels_json !== null) {
    worker.labels = JSON.parse(r.labels_json) as Record<string, string>;
  }
  if (r.metadata_json !== null) {
    worker.metadata = JSON.parse(r.metadata_json) as Record<string, unknown>;
  }
  return worker;
}

function leaseToRow(l: RuntimeLease): LeaseRow {
  return {
    leaseId: l.leaseId,
    agentId: l.agentId,
    holderId: l.holderId,
    workerId: l.workerId ?? null,
    sessionId: l.sessionId ?? null,
    state: l.state,
    acquiredAt: l.acquiredAt,
    expiresAt: l.expiresAt,
    renewedAt: l.renewedAt ?? null,
    releasedAt: l.releasedAt ?? null,
    expiredAt: l.expiredAt ?? null,
    metadata_json: l.metadata === undefined ? null : JSON.stringify(l.metadata),
  };
}

function wakeToRow(w: RuntimeWake): WakeRow {
  return {
    wakeId: w.wakeId,
    agentId: w.agentId,
    sessionId: w.sessionId ?? null,
    reason: w.reason,
    state: w.state,
    createdAt: w.createdAt,
    dueAt: w.dueAt,
    claimedAt: w.claimedAt ?? null,
    claimAttempts: w.claimAttempts ?? null,
    completedAt: w.completedAt ?? null,
    failedAt: w.failedAt ?? null,
    cancelledAt: w.cancelledAt ?? null,
    errorMessage: w.errorMessage ?? null,
    payload_json: w.payload === undefined ? null : JSON.stringify(w.payload),
  };
}

function workerToRow(w: RuntimeWorker): WorkerRow {
  return {
    workerId: w.workerId,
    holderId: w.holderId,
    state: w.state,
    capacity: w.capacity,
    registeredAt: w.registeredAt,
    heartbeatAt: w.heartbeatAt,
    heartbeatExpiresAt: w.heartbeatExpiresAt,
    drainedAt: w.drainedAt ?? null,
    evictedAt: w.evictedAt ?? null,
    withdrawnAt: w.withdrawnAt ?? null,
    labels_json: w.labels === undefined ? null : JSON.stringify(w.labels),
    metadata_json: w.metadata === undefined ? null : JSON.stringify(w.metadata),
  };
}

function cloneSnapshot(snapshot: RuntimeOrchestrationSnapshot): RuntimeOrchestrationSnapshot {
  // RuntimeLease/Wake/Worker are JSON-safe (flat scalar fields plus optional
  // metadata/payload/labels records of plain values), so a JSON round-trip
  // is a correct + cheap deep clone. We only ever clone the in-memory result
  // of readSnapshot, so there's no risk of Date/Map/Set inside.
  return JSON.parse(JSON.stringify(snapshot)) as RuntimeOrchestrationSnapshot;
}

function rowsEqual<T extends object>(a: T, b: T): boolean {
  // Stable comparison via JSON of the row shape (all keys are flat scalars
  // or already-stringified JSON columns), so this is order-independent
  // only if both sides come from the *same* serializer. We control both
  // sides — leaseToRow / wakeToRow / workerToRow — so the key order
  // matches and JSON.stringify is sufficient.
  return JSON.stringify(a) === JSON.stringify(b);
}

// ------------------------------------------------------------
// Prepared statements
// ------------------------------------------------------------

const SELECT_LEASES_SQL = `SELECT * FROM runtime_leases;`;
const SELECT_WAKES_SQL = `SELECT * FROM runtime_wakes;`;
const SELECT_WORKERS_SQL = `SELECT * FROM runtime_workers;`;

const INSERT_LEASE_SQL = `
  INSERT INTO runtime_leases (
    leaseId, agentId, holderId, workerId, sessionId, state,
    acquiredAt, expiresAt, renewedAt, releasedAt, expiredAt, metadata_json
  ) VALUES (
    @leaseId, @agentId, @holderId, @workerId, @sessionId, @state,
    @acquiredAt, @expiresAt, @renewedAt, @releasedAt, @expiredAt, @metadata_json
  );
`;
const UPDATE_LEASE_SQL = `
  UPDATE runtime_leases SET
    agentId = @agentId, holderId = @holderId, workerId = @workerId,
    sessionId = @sessionId, state = @state, acquiredAt = @acquiredAt,
    expiresAt = @expiresAt, renewedAt = @renewedAt, releasedAt = @releasedAt,
    expiredAt = @expiredAt, metadata_json = @metadata_json
  WHERE leaseId = @leaseId;
`;
const DELETE_LEASE_SQL = `DELETE FROM runtime_leases WHERE leaseId = ?;`;

const INSERT_WAKE_SQL = `
  INSERT INTO runtime_wakes (
    wakeId, agentId, sessionId, reason, state, createdAt, dueAt,
    claimedAt, claimAttempts, completedAt, failedAt, cancelledAt,
    errorMessage, payload_json
  ) VALUES (
    @wakeId, @agentId, @sessionId, @reason, @state, @createdAt, @dueAt,
    @claimedAt, @claimAttempts, @completedAt, @failedAt, @cancelledAt,
    @errorMessage, @payload_json
  );
`;
const UPDATE_WAKE_SQL = `
  UPDATE runtime_wakes SET
    agentId = @agentId, sessionId = @sessionId, reason = @reason,
    state = @state, createdAt = @createdAt, dueAt = @dueAt,
    claimedAt = @claimedAt, claimAttempts = @claimAttempts,
    completedAt = @completedAt, failedAt = @failedAt,
    cancelledAt = @cancelledAt, errorMessage = @errorMessage,
    payload_json = @payload_json
  WHERE wakeId = @wakeId;
`;
const DELETE_WAKE_SQL = `DELETE FROM runtime_wakes WHERE wakeId = ?;`;

const INSERT_WORKER_SQL = `
  INSERT INTO runtime_workers (
    workerId, holderId, state, capacity, registeredAt, heartbeatAt,
    heartbeatExpiresAt, drainedAt, evictedAt, withdrawnAt, labels_json, metadata_json
  ) VALUES (
    @workerId, @holderId, @state, @capacity, @registeredAt, @heartbeatAt,
    @heartbeatExpiresAt, @drainedAt, @evictedAt, @withdrawnAt, @labels_json, @metadata_json
  );
`;
const UPDATE_WORKER_SQL = `
  UPDATE runtime_workers SET
    holderId = @holderId, state = @state, capacity = @capacity,
    registeredAt = @registeredAt, heartbeatAt = @heartbeatAt,
    heartbeatExpiresAt = @heartbeatExpiresAt, drainedAt = @drainedAt,
    evictedAt = @evictedAt, withdrawnAt = @withdrawnAt,
    labels_json = @labels_json, metadata_json = @metadata_json
  WHERE workerId = @workerId;
`;
const DELETE_WORKER_SQL = `DELETE FROM runtime_workers WHERE workerId = ?;`;

// ------------------------------------------------------------
// Store
// ------------------------------------------------------------

export interface SqliteRuntimeOrchestrationStoreOptions {
  /** Path to the SQLite database file. Use ':memory:' for tests. */
  dbPath: string;
  /** Pragma `busy_timeout` in milliseconds. Defaults to 5_000. */
  busyTimeoutMs?: number;
  /** Set to false to skip pragma `journal_mode = WAL`. */
  walMode?: boolean;
}

/**
 * SQLite-backed RuntimeOrchestrationStore. Three normalized tables —
 * leases / wakes / workers — with diff-based writes inside one
 * BEGIN IMMEDIATE transaction per transact() call, so concurrent
 * processes block on the lock instead of clobbering each other.
 */
export class SqliteRuntimeOrchestrationStore implements RuntimeOrchestrationStore {
  private readonly db: BetterSqliteDB;
  private readonly selectLeases: Database.Statement;
  private readonly selectWakes: Database.Statement;
  private readonly selectWorkers: Database.Statement;
  private readonly insertLease: Database.Statement;
  private readonly updateLease: Database.Statement;
  private readonly deleteLease: Database.Statement;
  private readonly insertWake: Database.Statement;
  private readonly updateWake: Database.Statement;
  private readonly deleteWake: Database.Statement;
  private readonly insertWorker: Database.Statement;
  private readonly updateWorker: Database.Statement;
  private readonly deleteWorker: Database.Statement;

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

    this.selectLeases = this.db.prepare(SELECT_LEASES_SQL);
    this.selectWakes = this.db.prepare(SELECT_WAKES_SQL);
    this.selectWorkers = this.db.prepare(SELECT_WORKERS_SQL);
    this.insertLease = this.db.prepare(INSERT_LEASE_SQL);
    this.updateLease = this.db.prepare(UPDATE_LEASE_SQL);
    this.deleteLease = this.db.prepare(DELETE_LEASE_SQL);
    this.insertWake = this.db.prepare(INSERT_WAKE_SQL);
    this.updateWake = this.db.prepare(UPDATE_WAKE_SQL);
    this.deleteWake = this.db.prepare(DELETE_WAKE_SQL);
    this.insertWorker = this.db.prepare(INSERT_WORKER_SQL);
    this.updateWorker = this.db.prepare(UPDATE_WORKER_SQL);
    this.deleteWorker = this.db.prepare(DELETE_WORKER_SQL);
  }

  ensureSchema(): void {
    this.db.exec(SCHEMA_SQL);
  }

  async load(): Promise<RuntimeOrchestrationSnapshot> {
    return this.readSnapshot();
  }

  /**
   * Run `mutator` atomically. better-sqlite3 is synchronous, so we
   * cannot await inside its `transaction` wrapper — we manually emit
   * BEGIN/COMMIT and bridge the async mutator. The IMMEDIATE lock is
   * held for the whole call so other processes block at BEGIN until we
   * COMMIT or ROLLBACK.
   */
  async transact<TResult>(mutator: RuntimeOrchestrationMutator<TResult>): Promise<TResult> {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      // Read the baseline once, then hand the mutator a deep clone — most
      // RuntimeOrchestrator mutations are in-place (snapshot.leases.push,
      // lease.state = 'released', …), so without the clone `before` and
      // `after` would be the same object reference and the diff would see
      // zero changes.
      const before = this.readSnapshot();
      const working = cloneSnapshot(before);
      const { snapshot: after, result } = await mutator(working);
      this.applyDiff(before, after);
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // ignore — primary error already propagating
      }
      throw error;
    }
  }

  /** Close the underlying DB handle. Tests + graceful shutdown only. */
  close(): void {
    this.db.close();
  }

  // ------------------------------------------------------------
  // Internals
  // ------------------------------------------------------------

  private readSnapshot(): RuntimeOrchestrationSnapshot {
    const leases = (this.selectLeases.all() as LeaseRow[]).map(rowToLease);
    const wakes = (this.selectWakes.all() as WakeRow[]).map(rowToWake);
    const workers = (this.selectWorkers.all() as WorkerRow[]).map(rowToWorker);
    return { leases, wakes, workers };
  }

  private applyDiff(
    before: RuntimeOrchestrationSnapshot,
    after: RuntimeOrchestrationSnapshot,
  ): void {
    diffById(before.leases, after.leases, (l) => l.leaseId, leaseToRow, {
      insert: (row) => this.insertLease.run(row),
      update: (row) => this.updateLease.run(row),
      delete: (id) => this.deleteLease.run(id),
    });
    diffById(before.wakes, after.wakes, (w) => w.wakeId, wakeToRow, {
      insert: (row) => this.insertWake.run(row),
      update: (row) => this.updateWake.run(row),
      delete: (id) => this.deleteWake.run(id),
    });
    diffById(before.workers, after.workers, (w) => w.workerId, workerToRow, {
      insert: (row) => this.insertWorker.run(row),
      update: (row) => this.updateWorker.run(row),
      delete: (id) => this.deleteWorker.run(id),
    });
  }
}

interface DiffSinks<TRow> {
  insert(row: TRow): void;
  update(row: TRow): void;
  delete(id: string): void;
}

/**
 * Three-way diff over two collections keyed by id. Emits exactly:
 *   - one INSERT per id only present in `after`
 *   - one UPDATE per id whose row shape changed
 *   - one DELETE per id only present in `before`
 *
 * Rows whose shape didn't change generate zero writes, so an idle
 * transact() that touches nothing pays only the SELECTs + the BEGIN/
 * COMMIT round-trip — no unnecessary disk churn.
 */
function diffById<TDomain, TRow extends object>(
  before: TDomain[],
  after: TDomain[],
  keyOf: (item: TDomain) => string,
  toRow: (item: TDomain) => TRow,
  sinks: DiffSinks<TRow>,
): void {
  const beforeRows = new Map<string, TRow>();
  for (const item of before) beforeRows.set(keyOf(item), toRow(item));

  const seen = new Set<string>();
  for (const item of after) {
    const id = keyOf(item);
    seen.add(id);
    const newRow = toRow(item);
    const oldRow = beforeRows.get(id);
    if (!oldRow) {
      sinks.insert(newRow);
    } else if (!rowsEqual(oldRow, newRow)) {
      sinks.update(newRow);
    }
  }
  for (const id of beforeRows.keys()) {
    if (!seen.has(id)) sinks.delete(id);
  }
}

export function createSqliteRuntimeOrchestrationStore(
  options: SqliteRuntimeOrchestrationStoreOptions,
): SqliteRuntimeOrchestrationStore {
  return new SqliteRuntimeOrchestrationStore(options);
}
