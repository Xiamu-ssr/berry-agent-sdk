import { useState } from 'react';
import { setToken } from '../api/client.js';

export interface TokenModalProps {
  onSubmit(): void;
}

export function TokenModal({ onSubmit }: TokenModalProps) {
  const [value, setValue] = useState('');

  return (
    <div className="h-full flex items-center justify-center p-6 bg-gradient-to-br from-ink-50 to-ink-100 dark:from-ink-950 dark:to-ink-900">
      <div className="w-full max-w-md card shadow-lg animate-fade-in">
        <div className="flex items-center gap-2 mb-2">
          <span className="text-2xl">🍓</span>
          <h1 className="text-xl font-semibold">berry-a8s</h1>
        </div>
        <p className="text-sm text-ink-500 dark:text-ink-400 mb-6">
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
