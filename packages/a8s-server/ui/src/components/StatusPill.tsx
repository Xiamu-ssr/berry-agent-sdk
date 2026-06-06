import { Tag } from '@arco-design/web-react';

export type WorkerState = 'active' | 'draining' | 'evicted' | 'withdrawn';

// Arco Tag colors. 'gray' is the muted/neutral default.
const STATE_COLOR: Record<WorkerState, string> = {
  active: 'green',
  draining: 'orange',
  evicted: 'red',
  withdrawn: 'gray',
};

export function StatusPill({ state }: { state: WorkerState | string }) {
  const color = STATE_COLOR[state as WorkerState] ?? 'gray';
  return <Tag color={color} size="small">{state}</Tag>;
}

export function WakeStatePill({ state }: { state: 'pending' | 'claimed' | 'completed' | 'failed' | 'cancelled' | string }) {
  const color =
    state === 'completed' ? 'green' :
    state === 'failed' ? 'red' :
    state === 'claimed' ? 'orange' :
    'gray';
  return <Tag color={color} size="small">{state}</Tag>;
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
