import { useState } from 'react';
import { Card, Input, Button } from '@arco-design/web-react';
import { setToken } from '../api/client.js';
import { PeakMark } from './icons.js';

export interface TokenModalProps {
  onSubmit(): void;
}

export function TokenModal({ onSubmit }: TokenModalProps) {
  const [value, setValue] = useState('');

  const submit = () => {
    const trimmed = value.trim();
    if (!trimmed) return;
    setToken(trimmed);
    onSubmit();
  };

  return (
    <div
      className="h-full flex items-center justify-center p-6"
      style={{ background: 'linear-gradient(135deg, var(--color-bg-2), var(--color-fill-2))' }}
    >
      <Card className="w-full max-w-md animate-fade-in" style={{ boxShadow: 'var(--shadow2-center)' }}>
        <div className="flex items-center gap-2.5 mb-1">
          <span className="text-snow-600"><PeakMark /></span>
          <div className="leading-tight">
            <h1 className="text-lg font-semibold" style={{ color: 'var(--color-text-1)' }}>雪山引擎</h1>
            <div className="text-[11px] tracking-wide" style={{ color: 'var(--color-text-3)' }}>SNOW MOUNTAIN · a8s</div>
          </div>
        </div>
        <p className="text-sm mb-6 mt-3" style={{ color: 'var(--color-text-3)' }}>
          粘贴启动这台 a8s 时使用的 admin token(
          <code className="text-xs px-1 py-0.5 rounded" style={{ background: 'var(--color-fill-2)' }}>--admin-token</code>
          )。它只会保存在你的浏览器里。
        </p>
        <div className="space-y-4">
          <Input.Password
            value={value}
            onChange={setValue}
            onPressEnter={submit}
            autoFocus
            placeholder="Bearer token…"
            style={{ fontFamily: 'var(--font-mono, monospace)' }}
          />
          <Button type="primary" long disabled={!value.trim()} onClick={submit}>登录</Button>
        </div>
      </Card>
    </div>
  );
}
