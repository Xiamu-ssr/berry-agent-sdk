import { useHealth } from '../api/queries.js';
import { clearToken } from '../api/client.js';

export function Topbar({ title, onLogout }: { title: string; onLogout: () => void }) {
  const { data: health } = useHealth();
  return (
    <header className="h-14 border-b border-ink-200 dark:border-ink-800 px-6 flex items-center justify-between bg-white/60 dark:bg-ink-950/40 backdrop-blur">
      <div className="flex items-center gap-2 text-sm min-w-0">
        <span className="text-ink-400 dark:text-ink-600">雪山引擎</span>
        <span className="text-ink-300 dark:text-ink-700">/</span>
        <span className="font-medium text-ink-800 dark:text-ink-100 truncate">{title}</span>
      </div>
      <div className="flex items-center gap-4 shrink-0">
        <span className="flex items-center gap-1.5 text-xs text-ink-500 dark:text-ink-500 tabular-nums">
          <span
            className={`w-1.5 h-1.5 rounded-full ${health ? 'bg-emerald-500' : 'bg-ink-300 dark:bg-ink-600'}`}
          />
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
      </div>
    </header>
  );
}

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86_400)}d`;
}
