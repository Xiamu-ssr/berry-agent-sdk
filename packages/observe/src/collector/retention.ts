// ============================================================
// Berry Agent SDK — Observe: Retention / Cleanup
// ============================================================

import { lt, sql } from 'drizzle-orm';
import type { ObserveDB } from './db.js';
import { sessions, llmCalls, toolCalls, agentEvents } from './schema.js';

const DEFAULT_RAW_DAYS = 30;

/**
 * Delete expired detail records older than `rawDays` days.
 * Deletes from child tables first (FK order), then sessions.
 * Returns the number of sessions removed.
 */
export function cleanup(db: ObserveDB, rawDays: number = DEFAULT_RAW_DAYS): number {
  const cutoff = Date.now() - rawDays * 86_400_000;

  // Find sessions to remove
  const expiredSessions = db.db.select({ id: sessions.id })
    .from(sessions)
    .where(lt(sessions.startTime, cutoff))
    .all();

  if (expiredSessions.length === 0) return 0;

  const ids = expiredSessions.map((s) => s.id);

  // Delete children first (FK constraints)
  for (const id of ids) {
    db.db.delete(agentEvents).where(sql`${agentEvents.sessionId} = ${id}`).run();
    db.db.delete(toolCalls).where(sql`${toolCalls.sessionId} = ${id}`).run();
    db.db.delete(llmCalls).where(sql`${llmCalls.sessionId} = ${id}`).run();
    db.db.delete(sessions).where(sql`${sessions.id} = ${id}`).run();
  }

  return ids.length;
}
