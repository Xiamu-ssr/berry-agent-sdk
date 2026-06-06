import { useState } from 'react';
import {
  PeakMark, GridIcon, AgentIcon, ChatIcon, WorkerIcon, MachineIcon,
  LeaseIcon, ClockIcon, ModelIcon, KeyIcon, AuditIcon, HandIcon, SkillIcon,
} from './icons.js';

export type View =
  | 'dashboard'
  | 'agents'
  | 'hands'
  | 'skills'
  | 'admin'
  | 'workers'
  | 'machines'
  | 'leases'
  | 'wakes'
  | 'models'
  | 'credentials'
  | 'audit';

export interface SidebarProps {
  view: View;
  onSelect(view: View): void;
}

type Icon = (props: { className?: string }) => JSX.Element;

const GROUPS: Array<{ label: string; items: Array<{ key: View; label: string; icon: Icon }> }> = [
  {
    label: '总览',
    items: [{ key: 'dashboard', label: 'Dashboard', icon: GridIcon }],
  },
  {
    label: 'Agent',
    items: [
      { key: 'agents', label: 'Agents', icon: AgentIcon },
      { key: 'hands', label: 'Hand 市场', icon: HandIcon },
      { key: 'skills', label: 'Skill 市场', icon: SkillIcon },
      { key: 'admin', label: 'Admin chat', icon: ChatIcon },
    ],
  },
  {
    label: '算力',
    items: [
      { key: 'workers', label: 'Workers', icon: WorkerIcon },
      { key: 'machines', label: 'Machines', icon: MachineIcon },
      { key: 'leases', label: 'Leases', icon: LeaseIcon },
    ],
  },
  {
    label: '调度',
    items: [{ key: 'wakes', label: 'Wake queue', icon: ClockIcon }],
  },
  {
    label: '平台',
    items: [
      { key: 'models', label: 'Models', icon: ModelIcon },
      { key: 'credentials', label: 'Credentials', icon: KeyIcon },
      { key: 'audit', label: 'Audit log', icon: AuditIcon },
    ],
  },
];

/** Flat lookup so other components can resolve a view's label. */
export const VIEW_LABEL: Record<View, string> = Object.fromEntries(
  GROUPS.flatMap((g) => g.items.map((i) => [i.key, i.label])),
) as Record<View, string>;

export function Sidebar({ view, onSelect }: SidebarProps) {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <aside
      className={`${collapsed ? 'w-16' : 'w-60'} shrink-0 border-r border-ink-200 dark:border-ink-800
        bg-gradient-to-b from-ink-50 to-white dark:from-ink-950 dark:to-ink-900 flex flex-col transition-[width] duration-200`}
    >
      <div className="px-4 py-5 flex items-center gap-2.5">
        <span className="text-snow-600 dark:text-snow-400 shrink-0"><PeakMark /></span>
        {!collapsed && (
          <div className="leading-tight min-w-0">
            <div className="font-semibold text-ink-900 dark:text-ink-50 truncate">雪山引擎</div>
            <div className="text-[11px] text-ink-400 dark:text-ink-500 tracking-wide">SNOW MOUNTAIN</div>
          </div>
        )}
      </div>

      <nav className="flex-1 px-2 overflow-y-auto">
        {GROUPS.map((group) => (
          <div key={group.label}>
            {!collapsed && <div className="nav-group">{group.label}</div>}
            {group.items.map((item) => {
              const active = view === item.key;
              const Icon = item.icon;
              return (
                <button
                  key={item.key}
                  onClick={() => onSelect(item.key)}
                  title={collapsed ? item.label : undefined}
                  className={`w-full text-left px-3 py-2 my-0.5 rounded-md text-sm transition-colors flex items-center gap-3 ${
                    active
                      ? 'bg-white shadow-sm text-snow-700 ring-1 ring-snow-100 dark:bg-ink-800 dark:text-snow-300 dark:ring-ink-700'
                      : 'text-ink-600 hover:bg-white/70 dark:text-ink-400 dark:hover:bg-ink-900'
                  }`}
                >
                  <span className={`shrink-0 ${active ? 'text-snow-600 dark:text-snow-400' : 'text-ink-400 dark:text-ink-500'}`}>
                    <Icon className="w-[18px] h-[18px]" />
                  </span>
                  {!collapsed && item.label}
                </button>
              );
            })}
          </div>
        ))}
      </nav>

      <div className="px-3 py-3 border-t border-ink-200/70 dark:border-ink-800 flex items-center justify-between">
        {!collapsed && <span className="text-[11px] text-ink-400 dark:text-ink-600 px-1">a8s v0.5.0-alpha</span>}
        <button
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          title={collapsed ? 'Expand' : 'Collapse'}
          className="btn btn-ghost px-2 py-1 text-ink-400"
        >
          {collapsed ? '»' : '«'}
        </button>
      </div>
    </aside>
  );
}
