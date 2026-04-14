// ============================================================
// Berry Agent SDK — Observe: Database Initialization
// ============================================================

import Database, { type Database as DatabaseType } from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { sql } from 'drizzle-orm';
import * as schema from './schema.js';

export interface ObserveDB {
  db: BetterSQLite3Database<typeof schema>;
  sqlite: DatabaseType;
}

export function createDatabase(dbPath: string = ':memory:'): ObserveDB {
  const sqlite = new Database(dbPath);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');

  const db = drizzle(sqlite, { schema });

  // Create tables using Drizzle sql template tag
  db.run(sql`CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    agent_id TEXT,
    start_time INTEGER NOT NULL,
    end_time INTEGER,
    total_cost REAL NOT NULL DEFAULT 0,
    status TEXT NOT NULL
  )`);

  db.run(sql`CREATE TABLE IF NOT EXISTS llm_calls (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    agent_id TEXT,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    input_tokens INTEGER NOT NULL,
    output_tokens INTEGER NOT NULL,
    cache_read_tokens INTEGER NOT NULL DEFAULT 0,
    cache_write_tokens INTEGER NOT NULL DEFAULT 0,
    input_cost REAL NOT NULL,
    output_cost REAL NOT NULL,
    cache_savings REAL NOT NULL,
    total_cost REAL NOT NULL,
    latency_ms INTEGER NOT NULL,
    ttft_ms INTEGER,
    stop_reason TEXT NOT NULL,
    message_count INTEGER NOT NULL,
    tool_def_count INTEGER NOT NULL,
    system_block_count INTEGER NOT NULL,
    has_images INTEGER NOT NULL,
    skills_loaded TEXT,
    provider_detail TEXT,
    request_system TEXT,
    request_messages TEXT,
    request_tools TEXT,
    response_content TEXT,
    provider_request TEXT,
    provider_response TEXT,
    timestamp INTEGER NOT NULL
  )`);

  db.run(sql`CREATE TABLE IF NOT EXISTS tool_calls (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    llm_call_id TEXT REFERENCES llm_calls(id),
    name TEXT NOT NULL,
    input TEXT NOT NULL,
    output TEXT NOT NULL,
    is_error INTEGER NOT NULL,
    duration_ms INTEGER NOT NULL,
    timestamp INTEGER NOT NULL
  )`);

  db.run(sql`CREATE TABLE IF NOT EXISTS guard_decisions (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    llm_call_id TEXT REFERENCES llm_calls(id),
    tool_name TEXT NOT NULL,
    input TEXT NOT NULL,
    decision TEXT NOT NULL,
    reason TEXT,
    modified_input TEXT,
    call_index INTEGER NOT NULL,
    duration_ms INTEGER NOT NULL,
    timestamp INTEGER NOT NULL
  )`);

  db.run(sql`CREATE TABLE IF NOT EXISTS compaction_events (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    trigger_reason TEXT NOT NULL,
    context_before INTEGER NOT NULL,
    context_after INTEGER NOT NULL,
    threshold_pct REAL NOT NULL,
    context_window INTEGER NOT NULL,
    layers_applied TEXT NOT NULL,
    duration_ms INTEGER NOT NULL,
    tokens_freed INTEGER NOT NULL,
    timestamp INTEGER NOT NULL
  )`);

  db.run(sql`CREATE TABLE IF NOT EXISTS agent_events (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    kind TEXT NOT NULL,
    detail TEXT,
    timestamp INTEGER NOT NULL
  )`);

  // Migration: add columns to existing databases
  const migrations = [
    'ALTER TABLE sessions ADD COLUMN agent_id TEXT',
    'ALTER TABLE llm_calls ADD COLUMN agent_id TEXT',
    'ALTER TABLE llm_calls ADD COLUMN request_system TEXT',
    'ALTER TABLE llm_calls ADD COLUMN request_messages TEXT',
    'ALTER TABLE llm_calls ADD COLUMN request_tools TEXT',
    'ALTER TABLE llm_calls ADD COLUMN response_content TEXT',
    'ALTER TABLE llm_calls ADD COLUMN provider_request TEXT',
    'ALTER TABLE llm_calls ADD COLUMN provider_response TEXT',
  ];
  for (const stmt of migrations) {
    try { db.run(sql.raw(stmt)); } catch { /* column already exists */ }
  }

  return { db, sqlite };
}
