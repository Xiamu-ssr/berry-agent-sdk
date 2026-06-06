import { useState } from 'react';
import { setToken } from '../api/client.js';
import { PeakMark } from './icons.js';

export interface TokenModalProps {
  onSubmit(): void;
}

export function TokenModal({ onSubmit }: TokenModalProps) {
  const [value, setValue] = useState('');

  return (
    <div className="h-full flex items-center justify-center p-6 bg-gradient-to-br from-snow-50 to-ink-100 dark:from-ink-950 dark:to-ink-900">
      <div className="w-full max-w-md card-elevated shadow-lg animate-fade-in">
        <div className="flex items-center gap-2.5 mb-1">
          <span className="text-snow-600 dark:text-snow-400"><PeakMark /></span>
          <div className="leading-tight">
            <h1 className="text-lg font-semibold">雪山引擎</h1>
            <div className="text-[11px] text-ink-400 dark:text-ink-500 tracking-wide">SNOW MOUNTAIN · a8s</div>
          </div>
        </div>
        <p className="text-sm text-ink-500 dark:text-ink-400 mb-6 mt-3">
          Paste the admin token this a8s was started with
          (<code className="text-xs px-1 py-0.5 rounded bg-ink-100 dark:bg-ink-800">--admin-token</code>).
          It will be saved in your browser only.
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const trimmed = value.trim();
            if (!trimmed) return;
            setToken(trimmed);
            onSubmit();
          }}
          className="space-y-4"
        >
          <input
            type="password"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            autoComplete="off"
            autoFocus
            placeholder="Bearer token…"
            className="input font-mono text-sm"
          />
          <button type="submit" disabled={!value.trim()} className="btn btn-primary w-full">
            Sign in
          </button>
        </form>
      </div>
    </div>
  );
}
