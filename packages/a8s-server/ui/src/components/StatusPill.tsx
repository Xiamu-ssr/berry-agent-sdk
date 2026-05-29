export type WorkerState = 'active' | 'draining' | 'evicted' | 'withdrawn';

const STATE_CLASS: Record<WorkerState, string> = {
  active: 'pill pill-success',
  draining: 'pill pill-warn',
  evicted: 'pill pill-danger',
  withdrawn: 'pill pill-muted',
};

export function StatusPill({ state }: { state: WorkerState | string }) {
  const cls = STATE_CLASS[state as WorkerState] ?? 'pill pill-muted';
  return <span className={cls}>{state}</span>;
}

export function WakeStatePill({ state }: { state: 'pending' | 'claimed' | 'completed' | 'failed' | 'cancelled' | string }) {
  const cls =
    state === 'completed' ? 'pill pill-success' :
    state === 'failed' ? 'pill pill-danger' :
    state === 'claimed' ? 'pill pill-warn' :
    'pill pill-muted';
  return <span className={cls}>{state}</span>;
}

export function relativeTime(ts: number | undefined): string {
  if (!ts) return '—';
  const delta = Date.now() - ts;
  if (delta < 0) return formatFuture(-delta);
  if (delta < 60_000) return `${Math.round(delta / 1000)}s ago`;
  if (delta < 3_600_000) return `${Math.round(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.round(delta / 3_600_000)}h ago`;
  return `${Math.round(delta / 86_400_000)}d ago`;
}

function formatFuture(deltaMs: number): string {
  if (deltaMs < 60_000) return `in ${Math.round(deltaMs / 1000)}s`;
  if (deltaMs < 3_600_000) return `in ${Math.round(deltaMs / 60_000)}m`;
  if (deltaMs < 86_400_000) return `in ${Math.round(deltaMs / 3_600_000)}h`;
  return `in ${Math.round(deltaMs / 86_400_000)}d`;
}
