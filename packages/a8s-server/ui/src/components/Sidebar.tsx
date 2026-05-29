export type View = 'dashboard' | 'workers' | 'agents' | 'wakes' | 'admin';

export interface SidebarProps {
  view: View;
  onSelect(view: View): void;
}

const NAV: Array<{ key: View; label: string; icon: string }> = [
  { key: 'dashboard', label: 'Dashboard', icon: '◐' },
  { key: 'workers', label: 'Workers', icon: '▤' },
  { key: 'agents', label: 'Agents', icon: '◊' },
  { key: 'wakes', label: 'Wake queue', icon: '⏰' },
  { key: 'admin', label: 'Admin chat', icon: '✦' },
];

export function Sidebar({ view, onSelect }: SidebarProps) {
  return (
    <aside className="w-56 shrink-0 border-r border-ink-200 dark:border-ink-800 bg-ink-50 dark:bg-ink-950 flex flex-col">
      <div className="px-5 py-5 flex items-center gap-2">
        <span className="text-xl">🍓</span>
        <span className="font-semibold">berry-a8s</span>
      </div>
      <nav className="flex-1 px-2">
        {NAV.map((item) => {
          const active = view === item.key;
          return (
            <button
              key={item.key}
              onClick={() => onSelect(item.key)}
              className={`w-full text-left px-3 py-2 my-0.5 rounded-md text-sm transition-colors flex items-center gap-3 ${
                active
                  ? 'bg-white shadow-sm text-ink-900 dark:bg-ink-800 dark:text-ink-100'
                  : 'text-ink-600 hover:bg-white/60 dark:text-ink-400 dark:hover:bg-ink-900'
              }`}
            >
              <span className="text-base text-ink-400 dark:text-ink-500 w-4 text-center">{item.icon}</span>
              {item.label}
            </button>
          );
        })}
      </nav>
      <div className="px-5 py-4 text-xs text-ink-400 dark:text-ink-600">
        v0.5.0-alpha
      </div>
    </aside>
  );
}
