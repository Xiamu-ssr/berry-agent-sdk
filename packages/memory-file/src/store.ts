/**
 * SQLite FTS5-backed chunk store.
 *
 * Mirrors what OpenClaw's memory-core does on disk: one sqlite file per
 * agent, one `chunks` table with FTS5 mirror. We keep the schema minimal —
 * v0.4.0 is keyword-only, so no vector column yet, but the layout leaves
 * room for one (`embedding BLOB`) when we upgrade in v0.4.1.
 */

import Database from 'better-sqlite3';
import type { Database as SqliteDb } from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import type { Chunk } from './chunker.js';

export interface StoredChunk extends Chunk {
  id: string;
  path: string;       // source file path, relative to workspace
  mtime: number;      // source file mtime at index time
}

export interface SearchHit {
  id: string;
  path: string;
  startLine: number;
  endLine: number;
  snippet: string;
  /** Raw BM25 score from FTS5 — lower is more relevant, so we invert later. */
  bm25: number;
}

export class ChunkStore {
  private db: SqliteDb;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.init();
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chunks (
        id         TEXT PRIMARY KEY,
        path       TEXT NOT NULL,
        start_line INTEGER NOT NULL,
        end_line   INTEGER NOT NULL,
        text       TEXT NOT NULL,
        mtime      INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS chunks_path_idx ON chunks(path);

      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
        text,
        content='chunks',
        content_rowid='rowid',
        tokenize='unicode61'
      );

      CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
        INSERT INTO chunks_fts(rowid, text) VALUES (new.rowid, new.text);
      END;
      CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
        INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
      END;
      CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE ON chunks BEGIN
        INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
        INSERT INTO chunks_fts(rowid, text) VALUES (new.rowid, new.text);
      END;
    `);
  }

  /** Replace all chunks for a single file. Atomic within the transaction. */
  replaceFile(params: { filePath: string; mtime: number; chunks: Chunk[]; idFor: (chunk: Chunk) => string }): void {
    const { filePath, mtime, chunks, idFor } = params;
    const del = this.db.prepare(`DELETE FROM chunks WHERE path = ?`);
    const ins = this.db.prepare(`
      INSERT INTO chunks (id, path, start_line, end_line, text, mtime)
      VALUES (@id, @path, @startLine, @endLine, @text, @mtime)
    `);
    const tx = this.db.transaction(() => {
      del.run(filePath);
      for (const c of chunks) {
        ins.run({
          id: idFor(c),
          path: filePath,
          startLine: c.startLine,
          endLine: c.endLine,
          text: c.text,
          mtime,
        });
      }
    });
    tx();
  }

  removeFile(filePath: string): void {
    this.db.prepare(`DELETE FROM chunks WHERE path = ?`).run(filePath);
  }

  getFileMtime(filePath: string): number | null {
    const row = this.db
      .prepare(`SELECT mtime FROM chunks WHERE path = ? LIMIT 1`)
      .get(filePath) as { mtime: number } | undefined;
    return row ? row.mtime : null;
  }

  /**
   * FTS5 MATCH search with BM25 ranking. Returns `limit` hits, each with
   * a raw bm25 value (lower = more relevant).
   *
   * The query is passed through `buildFtsQuery()` to be permissive: we want
   * OR semantics by default so any keyword match surfaces, matching the
   * recall posture memory_search is supposed to have.
   */
  search(query: string, limit: number): SearchHit[] {
    const ftsQuery = buildFtsQuery(query);
    if (!ftsQuery) return [];

    const rows = this.db
      .prepare(
        `
        SELECT c.id AS id, c.path AS path, c.start_line AS startLine,
               c.end_line AS endLine, c.text AS text,
               bm25(chunks_fts) AS bm25
        FROM chunks_fts
        JOIN chunks c ON c.rowid = chunks_fts.rowid
        WHERE chunks_fts MATCH ?
        ORDER BY bm25 ASC
        LIMIT ?
      `,
      )
      .all(ftsQuery, limit) as {
      id: string;
      path: string;
      startLine: number;
      endLine: number;
      text: string;
      bm25: number;
    }[];

    return rows.map((r) => ({
      id: r.id,
      path: r.path,
      startLine: r.startLine,
      endLine: r.endLine,
      snippet: r.text,
      bm25: r.bm25,
    }));
  }

  listIndexedFiles(): { path: string; mtime: number }[] {
    const rows = this.db
      .prepare(`SELECT DISTINCT path, mtime FROM chunks`)
      .all() as { path: string; mtime: number }[];
    return rows;
  }

  close(): void {
    this.db.close();
  }
}

/**
 * Convert free-form user query to an FTS5 MATCH expression.
 *
 * Rules:
 * - strip anything that isn't a word char / CJK char / space
 * - split on whitespace
 * - join with " OR " so any token match wins (Hermes-style FTS5 AND is too
 *   strict for the vague queries agents tend to make)
 * - quote each token so FTS5 treats it as a literal (avoids accidental
 *   column filter, AND/OR/NOT parsing, etc.)
 */
export function buildFtsQuery(raw: string): string {
  const cleaned = raw.replace(/[^\p{L}\p{N}_\s]/gu, ' ');
  const tokens = cleaned.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return '';
  return tokens.map((t) => `"${t.replace(/"/g, '')}"`).join(' OR ');
}
