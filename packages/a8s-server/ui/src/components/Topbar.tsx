import type { ReactNode } from 'react';
import { Breadcrumb, Badge, Button, Modal } from '@arco-design/web-react';
import { useHealth } from '../api/queries.js';
import { clearToken } from '../api/client.js';

export function Topbar({ title, onLogout }: { title: string; onLogout: () => void }) {
  const { data: health } = useHealth();
  return (
    <header
      className="h-14 px-6 flex items-center justify-between backdrop-blur"
      style={{ borderBottom: '1px solid var(--color-border-2)', background: 'var(--color-bg-2)' }}
    >
      <Breadcrumb>
        <Breadcrumb.Item>雪山引擎</Breadcrumb.Item>
        <Breadcrumb.Item>{title}</Breadcrumb.Item>
      </Breadcrumb>
      <div className="flex items-center gap-4 shrink-0">
        <span className="flex items-center gap-1.5 text-xs tabular-nums" style={{ color: 'var(--color-text-3)' }}>
          <Badge status={health ? 'success' : 'default'} />
          {health ? `a8s ${health.version} · up ${formatUptime(health.uptime)}` : 'connecting…'}
        </span>
        <Button type="text" size="small" onClick={() => resetToken(onLogout)}>重置 token</Button>
      </div>
    </header>
  );
}

function resetToken(onLogout: () => void): void {
  Modal.confirm({
    title: '重置 admin token?',
    content: '重置后需要重新粘贴 token 才能继续操作。' as ReactNode,
    okText: '重置',
    cancelText: '取消',
    onOk: () => { clearToken(); onLogout(); },
  });
}

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86_400)}d`;
}
