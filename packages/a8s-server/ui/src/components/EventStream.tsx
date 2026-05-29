import { useEffect, useRef, useState } from 'react';
import { apiRaw } from '../api/client.js';

interface SSEEvent {
  id: string;
  type: string;
  data: string;
}

export function EventStream({ agentId, sessionId }: { agentId: string; sessionId: string }) {
  const [events, setEvents] = useState<SSEEvent[]>([]);
  const [status, setStatus] = useState<'connecting' | 'live' | 'error'>('connecting');
  const containerRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<AbortController | null>(null);

  useEffect(() => {
    setEvents([]);
    setStatus('connecting');
    const ctrl = new AbortController();
    cancelRef.current = ctrl;

    void (async () => {
      try {
        const resp = await apiRaw(
          `/v1/agents/${encodeURIComponent(agentId)}/events/stream?session=${encodeURIComponent(sessionId)}`,
          {
            headers: { accept: 'text/event-stream' },
            signal: ctrl.signal,
          },
        );
        if (!resp.ok || !resp.body) throw new Error(`SSE HTTP ${resp.status}`);
        setStatus('live');
        const reader = resp.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let sep;
          while ((sep = buf.indexOf('\n\n')) !== -1) {
            const block = buf.slice(0, sep);
            buf = buf.slice(sep + 2);
            const lines = block.split('\n').filter((l) => !l.startsWith(':'));
            const id = lines.find((l) => l.startsWith('id:'))?.slice(3).trim() ?? '';
            const type = lines.find((l) => l.startsWith('event:'))?.slice(6).trim() ?? '';
            const data = lines.find((l) => l.startsWith('data:'))?.slice(5).trim() ?? '';
            if (!id) continue;
            setEvents((prev) => [...prev, { id, type, data }]);
            requestAnimationFrame(() => {
              const el = containerRef.current;
              if (el) el.scrollTop = el.scrollHeight;
            });
          }
        }
      } catch (err) {
        if ((err as { name?: string }).name === 'AbortError') return;
        setStatus('error');
      }
    })();

    return () => ctrl.abort();
  }, [agentId, sessionId]);

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-xs">
        <span
          className={`inline-block w-2 h-2 rounded-full ${
            status === 'live'
              ? 'bg-emerald-500 animate-pulse-slow'
              : status === 'error'
              ? 'bg-berry-500'
              : 'bg-ink-400'
          }`}
        />
        <span className="text-ink-500 dark:text-ink-400">
          {status === 'live' && `live · ${events.length} events`}
          {status === 'connecting' && 'connecting…'}
          {status === 'error' && 'connection error'}
        </span>
      </div>
      <div
        ref={containerRef}
        className="h-96 overflow-y-auto bg-ink-50 dark:bg-ink-950 rounded-md font-mono text-[11px] p-3 space-y-1"
      >
        {events.map((e) => (
          <div key={e.id} className="border-b border-ink-100 dark:border-ink-900 pb-1">
            <span className="text-berry-600 dark:text-berry-400 font-semibold">{e.type}</span>
            <span className="text-ink-400 dark:text-ink-600 ml-2 text-[10px]">{e.id.slice(0, 12)}</span>
            <div className="text-ink-700 dark:text-ink-300 whitespace-pre-wrap break-all">
              {truncate(e.data, 400)}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + '…';
}
