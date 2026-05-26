// ============================================================
// Berry Agent SDK — JSONL Event Log Store
// ============================================================
// One JSONL file per session. Append-only, crash-recoverable.
// Storage layout: {sessionsDir}/{sessionId}/events.jsonl
// Per AGENTS.md, both messages.json and events.jsonl live under
// the same sessions/<sid>/ subdirectory.

import { createReadStream } from 'node:fs';
import { appendFile, mkdir, open, readdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { EventLogStore, SessionEvent, GetEventsOptions, SessionEventType } from './types.js';
import { zSessionEvent } from './schema.js';

const DEFAULT_TAIL_SCAN_BYTES = 16 * 1024 * 1024;
const TAIL_CHUNK_BYTES = 256 * 1024;

/**
 * File-based EventLogStore using JSONL (one JSON object per line).
 *
 * - append(): writes one JSON line + newline (atomic at OS level for small writes)
 * - appendBatch(): writes multiple lines in one I/O call
 * - getEvents(): reads + parses + filters; truncates incomplete last line on read (crash recovery)
 * - count(): efficient line count without full JSON parsing
 * - listSessions(): scans directory for session subdirectories containing events.jsonl
 */
export class FileEventLogStore implements EventLogStore {
  private readonly sessionsDir: string;

  /**
   * @param sessionsDir The sessions root directory (e.g. `{root}/sessions/`).
   *   Each session's events live at `{sessionsDir}/{sessionId}/events.jsonl`.
   */
  constructor(sessionsDir: string) {
    this.sessionsDir = sessionsDir;
  }

  /** Append a single event. */
  async append(sessionId: string, event: SessionEvent): Promise<void> {
    await this.ensureDir(sessionId);
    const line = JSON.stringify(zSessionEvent.parse(event)) + '\n';
    await appendFile(this.filePath(sessionId), line, 'utf-8');
  }

  /** Append multiple events in one write. */
  async appendBatch(sessionId: string, events: SessionEvent[]): Promise<void> {
    if (events.length === 0) return;
    await this.ensureDir(sessionId);
    const lines = events.map(e => JSON.stringify(zSessionEvent.parse(e))).join('\n') + '\n';
    await appendFile(this.filePath(sessionId), lines, 'utf-8');
  }

  /** Read events with optional filtering. Handles crash recovery (truncates incomplete last line). */
  async getEvents(sessionId: string, options?: GetEventsOptions): Promise<SessionEvent[]> {
    if (typeof options?.tail === 'number' && options.tail > 0) {
      return this.getTailEvents(sessionId, options);
    }
    return this.getForwardEvents(sessionId, options);
  }

  /** Get event count without full JSON parsing. */
  async count(sessionId: string): Promise<number> {
    const path = this.filePath(sessionId);
    let count = 0;
    let sawNonWhitespace = false;
    let lastByte = 0;
    try {
      for await (const chunk of createReadStream(path)) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        for (const byte of buf) {
          if (byte === 10) count++;
          if (byte !== 10 && byte !== 13 && byte !== 32 && byte !== 9) sawNonWhitespace = true;
          lastByte = byte;
        }
      }
    } catch (err: unknown) {
      if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
        return 0;
      }
      throw err;
    }
    if (sawNonWhitespace && lastByte !== 10) count++;
    return count;
  }

  /** List all session IDs that have event log files. */
  async listSessions(): Promise<string[]> {
    try {
      const entries = await readdir(this.sessionsDir, { withFileTypes: true });
      const sessionIds: string[] = [];
      for (const entry of entries) {
        if (entry.isDirectory()) {
          // Check if events.jsonl exists in this session directory
          try {
            const eventsPath = join(this.sessionsDir, entry.name, 'events.jsonl');
            await stat(eventsPath);
            sessionIds.push(decodeURIComponent(entry.name));
          } catch {
            // No events.jsonl — skip this directory
          }
        }
      }
      return sessionIds.sort();
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
    const safe = encodeURIComponent(sessionId);
    return join(this.sessionsDir, safe, 'events.jsonl');
  }

  private async getForwardEvents(sessionId: string, options?: GetEventsOptions): Promise<SessionEvent[]> {
    const path = this.filePath(sessionId);
    const typeSet = options?.types && options.types.length > 0 ? new Set(options.types) : undefined;
    const events: SessionEvent[] = [];
    let index = 0;
    try {
      const rl = createInterface({
        input: createReadStream(path, { encoding: 'utf-8' }),
        crlfDelay: Infinity,
      });
      for await (const line of rl) {
        const event = this.parseLine(line, typeSet);
        if (!event) continue;
        if (options?.since !== undefined && event.timestamp < options.since) continue;
        if (options?.from !== undefined && index < options.from) {
          index++;
          continue;
        }
        if (options?.to !== undefined && index >= options.to) break;
        events.push(event);
        index++;
      }
      return events;
    } catch (err: unknown) {
      if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw err;
    }
  }

  private async getTailEvents(sessionId: string, options: GetEventsOptions): Promise<SessionEvent[]> {
    const typeSet = options.types && options.types.length > 0 ? new Set(options.types) : undefined;
    const limit = Math.max(1, options.tail ?? 1);
    const lines = await this.readTailLines(sessionId, {
      minMatchingLines: limit,
      maxBytes: options.maxBytes ?? DEFAULT_TAIL_SCAN_BYTES,
      typeSet,
    });
    const events: SessionEvent[] = [];
    for (const line of lines) {
      const event = this.parseLine(line, typeSet);
      if (!event) continue;
      if (options.since !== undefined && event.timestamp < options.since) continue;
      events.push(event);
    }
    return events.slice(-limit);
  }

  private async readTailLines(
    sessionId: string,
    options: { minMatchingLines: number; maxBytes: number; typeSet?: Set<SessionEventType> },
  ): Promise<string[]> {
    const path = this.filePath(sessionId);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(path, 'r');
      const { size } = await handle.stat();
      if (size === 0) return [];

      let position = size;
      let scanned = 0;
      let prefix = '';
      let lines: string[] = [];
      while (position > 0 && scanned < options.maxBytes) {
        const readSize = Math.min(TAIL_CHUNK_BYTES, position, options.maxBytes - scanned);
        position -= readSize;
        scanned += readSize;
        const buffer = Buffer.allocUnsafe(readSize);
        await handle.read(buffer, 0, readSize, position);
        const text = buffer.toString('utf-8') + prefix;
        const parts = text.split('\n');
        prefix = parts.shift() ?? '';
        lines = parts.concat(lines);
        const matching = this.countLikelyMatchingLines(lines, options.typeSet);
        if (matching >= options.minMatchingLines) break;
      }
      if (position === 0 && prefix.trim()) {
        lines.unshift(prefix);
      }
      return lines.filter((line) => line.trim()).slice(-Math.max(options.minMatchingLines * 4, options.minMatchingLines));
    } catch (err: unknown) {
      if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw err;
    } finally {
      await handle?.close();
    }
  }

  private countLikelyMatchingLines(lines: string[], typeSet?: Set<SessionEventType>): number {
    let count = 0;
    for (const line of lines) {
      if (!line.trim()) continue;
      if (typeSet && !lineMayContainType(line, typeSet)) continue;
      count++;
    }
    return count;
  }

  private parseLine(line: string, typeSet?: Set<SessionEventType>): SessionEvent | null {
    const trimmed = line.trim();
    if (!trimmed) return null;
    if (typeSet && !lineMayContainType(trimmed, typeSet)) return null;
    try {
      const event = zSessionEvent.parse(JSON.parse(trimmed));
      if (typeSet && !typeSet.has(event.type)) return null;
      return event;
    } catch {
      // Incomplete last line from crash — skip it (crash recovery).
      return null;
    }
  }

  private ensuredDirs = new Set<string>();
  private async ensureDir(sessionId: string): Promise<void> {
    const safe = encodeURIComponent(sessionId);
    if (this.ensuredDirs.has(safe)) return;
    await mkdir(join(this.sessionsDir, safe), { recursive: true });
    this.ensuredDirs.add(safe);
  }
}

function lineMayContainType(line: string, typeSet: Set<SessionEventType>): boolean {
  for (const type of typeSet) {
    if (line.includes(`"type":"${type}"`) || line.includes(`"type": "${type}"`)) return true;
  }
  return false;
}
