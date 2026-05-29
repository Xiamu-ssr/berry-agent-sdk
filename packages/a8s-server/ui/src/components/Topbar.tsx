import { useHealth } from '../api/queries.js';
import { clearToken } from '../api/client.js';

export function Topbar({ onLogout }: { onLogout: () => void }) {
  const { data: health } = useHealth();
  return (
    <header className="h-14 border-b border-ink-200 dark:border-ink-800 px-6 flex items-center justify-end gap-4">
      <span className="text-xs text-ink-500 dark:text-ink-500 tabular-nums">
        {health ? `a8s ${health.version} · up ${formatUptime(health.uptime)}` : 'connecting…'}
      </span>
      <button
        type="button"
        onClick={() => {
          if (confirm('Reset admin token? You will need to paste it again.')) {
            clearToken();
            onLogout();
          }
        }}
        className="btn btn-ghost text-xs"
      >
        Reset token
      </button>
    </header>
  );
}

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86_400)}d`;
}
