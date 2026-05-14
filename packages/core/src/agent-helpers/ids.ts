// ============================================================
// Agent helpers — ID generators
// ============================================================
// Pure, dependency-free functions extracted from agent.ts.
// Shape of the generated ids is a contract: log parsers and
// persisted session files rely on these prefixes, so change
// with care.

export function generateId(): string {
  return `ses_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export function generateEventId(): string {
  return `evt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export function generateTurnId(): string {
  return `turn_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}
