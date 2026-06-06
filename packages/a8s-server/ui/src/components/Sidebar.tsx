import { Layout, Menu, Button } from '@arco-design/web-react';
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
  collapsed: boolean;
  onCollapse(collapsed: boolean): void;
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

/**
 * The console's left rail. Arco `Layout.Sider` (collapse/brand/footer) wrapping
 * a controlled `Menu` — the existing useState routing maps 1:1 to Menu keys, so
 * no router is needed. We keep the hand-drawn brand icons (the visual language
 * is ours) rather than swapping to generic Arco glyphs.
 */
export function Sidebar({ view, onSelect, collapsed, onCollapse }: SidebarProps) {
  return (
    <Layout.Sider
      collapsible
      collapsed={collapsed}
      onCollapse={(c) => onCollapse(c)}
      width={232}
      collapsedWidth={64}
      trigger={null}
      breakpoint="xl"
      style={{ borderRight: '1px solid var(--color-border-2)' }}
    >
      <div className="h-full flex flex-col">
        <div className="px-4 py-5 flex items-center gap-2.5">
          <span className="text-snow-600 shrink-0"><PeakMark /></span>
          {!collapsed && (
            <div className="leading-tight min-w-0">
              <div className="font-semibold truncate" style={{ color: 'var(--color-text-1)' }}>雪山引擎</div>
              <div className="text-[11px] tracking-wide" style={{ color: 'var(--color-text-3)' }}>SNOW MOUNTAIN</div>
            </div>
          )}
        </div>

        <div className="flex-1 overflow-y-auto">
          <Menu
            selectedKeys={[view]}
            onClickMenuItem={(key) => onSelect(key as View)}
            collapse={collapsed}
            style={{ width: '100%', border: 'none', background: 'transparent' }}
          >
            {GROUPS.map((group) => (
              <Menu.ItemGroup key={group.label} title={group.label}>
                {group.items.map((item) => {
                  const Icon = item.icon;
                  return (
                    <Menu.Item key={item.key}>
                      <Icon className="w-[18px] h-[18px] inline-block align-[-3px] mr-1" />
                      {item.label}
                    </Menu.Item>
                  );
                })}
              </Menu.ItemGroup>
            ))}
          </Menu>
        </div>

        <div
          className="px-3 py-3 flex items-center justify-between"
          style={{ borderTop: '1px solid var(--color-border-2)' }}
        >
          {!collapsed && (
            <span className="text-[11px] px-1" style={{ color: 'var(--color-text-3)' }}>a8s v0.5.0-alpha</span>
          )}
          <Button
            type="text"
            size="small"
            onClick={() => onCollapse(!collapsed)}
            title={collapsed ? '展开' : '收起'}
            style={{ color: 'var(--color-text-3)' }}
          >
            {collapsed ? '»' : '«'}
          </Button>
        </div>
      </div>
    </Layout.Sider>
  );
}
