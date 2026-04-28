// ============================================================
// Berry Agent SDK — JSONL Event Log Store
// ============================================================
// One JSONL file per session. Append-only, crash-recoverable.
// Storage layout: {baseDir}/.berry/sessions/{sessionId}.jsonl

import { readFile, writeFile, appendFile, readdir, mkdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { EventLogStore, SessionEvent, GetEventsOptions } from './types.js';

/**
 * File-based EventLogStore using JSONL (one JSON object per line).
 *
 * - append(): writes one JSON line + newline (atomic at OS level for small writes)
 * - appendBatch(): writes multiple lines in one I/O call
 * - getEvents(): reads + parses + filters; truncates incomplete last line on read (crash recovery)
 * - count(): efficient line count without full parsing
 * - listSessions(): scans directory for .jsonl files
 */
export class FileEventLogStore implements EventLogStore {
  private readonly sessionsDir: string;

  constructor(baseDir: string) {
    this.sessionsDir = join(baseDir, '.berry', 'sessions');
  }

  /** Append a single event. */
  async append(sessionId: string, event: SessionEvent): Promise<void> {
    await this.ensureDir();
    const line = JSON.stringify(event) + '\n';
    await appendFile(this.filePath(sessionId), line, 'utf-8');
  }

  /** Append multiple events in one write. */
  async appendBatch(sessionId: string, events: SessionEvent[]): Promise<void> {
    if (events.length === 0) return;
    await this.ensureDir();
    const lines = events.map(e => JSON.stringify(e)).join('\n') + '\n';
    await appendFile(this.filePath(sessionId), lines, 'utf-8');
  }

  /** Read events with optional filtering. Handles crash recovery (truncates incomplete last line). */
  async getEvents(sessionId: string, options?: GetEventsOptions): Promise<SessionEvent[]> {
    const raw = await this.readRaw(sessionId);
    if (!raw) return [];

    const lines = raw.split('\n');
    let events: SessionEvent[] = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        events.push(JSON.parse(trimmed) as SessionEvent);
      } catch {
        // Incomplete last line from crash — skip it (crash recovery)
      }
    }

    // Apply filters
    if (options?.types && options.types.length > 0) {
      const typeSet = new Set(options.types);
      events = events.filter(e => typeSet.has(e.type));
    }
    if (options?.since !== undefined) {
      const since = options.since;
      events = events.filter(e => e.timestamp >= since);
    }
    if (options?.from !== undefined || options?.to !== undefined) {
      const from = options?.from ?? 0;
      const to = options?.to ?? events.length;
      events = events.slice(from, to);
    }

    return events;
  }

  /** Get event count without full JSON parsing. */
  async count(sessionId: string): Promise<number> {
    const raw = await this.readRaw(sessionId);
    if (!raw) return 0;
    // Count non-empty lines
    let count = 0;
    const lines = raw.split('\n');
    for (const line of lines) {
      if (line.trim()) count++;
    }
    return count;
  }

  /** List all session IDs that have event log files. */
  async listSessions(): Promise<string[]> {
    try {
      const files = await readdir(this.sessionsDir);
      return files
        .filter(f => f.endsWith('.jsonl'))
        .map(f => f.slice(0, -6)) // strip .jsonl
        .sort();
    } catch {
      // Directory doesn't exist yet
      return [];
    }
  }

  /** Delete the event log file for a session (used by clearSession). */
  async clear(sessionId: string): Promise<void> {
    const path = this.filePath(sessionId);
    try {
      await unlink(path);
    } catch (err: unknown) {
      if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
        // File doesn't exist — nothing to clear
        return;
      }
      throw err;
    }
  }

  // ----- Internal -----

  private filePath(sessionId: string): string {
    // Sanitize session ID for use as filename
    const safe = encodeURIComponent(sessionId);
    return join(this.sessionsDir, `${safe}.jsonl`);
  }

  private async readRaw(sessionId: string): Promise<string | null> {
    try {
      return await readFile(this.filePath(sessionId), 'utf-8');
    } catch (err: unknown) {
      if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      throw err;
    }
  }

  private dirEnsured = false;
  private async ensureDir(): Promise<void> {
    if (this.dirEnsured) return;
    await mkdir(this.sessionsDir, { recursive: true });
    this.dirEnsured = true;
  }
}
