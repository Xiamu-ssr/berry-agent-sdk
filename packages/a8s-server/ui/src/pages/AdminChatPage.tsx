import { useEffect, useMemo, useRef, useState } from 'react';
import { Card, Button, Input } from '@arco-design/web-react';
import {
  useAdminChat,
  useSessions,
  useSessionEvents,
  type RawSessionEvent,
} from '../api/queries.js';
import { PageHeader, Spinner } from '../components/Page.js';
import { relativeTime } from '../components/StatusPill.js';

const ADMIN_AGENT = 'berry-admin';

// Module-level memory of the active session id. Survives tab switches
// (component unmount) within a single page load, so returning to Admin
// chat reopens the same conversation instead of starting blank. The
// durable history itself lives in the SDK session on the worker — this is
// just "which session was I looking at".
let lastActiveSessionId: string | null = null;

interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system';
  text: string;
}

export function AdminChatPage() {
  const sessions = useSessions(ADMIN_AGENT);
  const [sessionId, setSessionId] = useState<string | null>(lastActiveSessionId);
  // Locally-appended messages for the turn(s) sent this mount; merged on
  // top of the loaded history. Cleared when switching sessions.
  const [live, setLive] = useState<Message[]>([]);
  const [draft, setDraft] = useState('');
  const send = useAdminChat();
  const history = useSessionEvents(ADMIN_AGENT, sessionId);
  const containerRef = useRef<HTMLDivElement>(null);

  // Persist selection across unmounts.
  useEffect(() => { lastActiveSessionId = sessionId; }, [sessionId]);

  // Default to the most recent session once the list loads (if none picked).
  useEffect(() => {
    if (sessionId === null && sessions.data && sessions.data.length > 0) {
      setSessionId(sessions.data[0].id);
    }
  }, [sessions.data, sessionId]);

  const historyMessages = useMemo(
    () => (history.data ? eventsToMessages(history.data) : []),
    [history.data],
  );
  const messages = useMemo(() => [...historyMessages, ...live], [historyMessages, live]);

  useEffect(() => {
    requestAnimationFrame(() => {
      const el = containerRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    });
  }, [messages.length, send.isPending]);

  const selectSession = (id: string | null) => {
    setSessionId(id);
    setLive([]); // history for the newly selected session replaces live bubbles
  };

  const submit = async () => {
    const prompt = draft.trim();
    if (!prompt) return;
    setDraft('');
    setLive((m) => [...m, { id: `u-${Date.now()}`, role: 'user', text: prompt }]);
    try {
      const resp = await send.mutateAsync({ prompt, sessionId: sessionId ?? undefined });
      const newSid = resp.sessionId ?? resp.result?.sessionId;
      const text = extractText(resp);
      if (newSid && newSid !== sessionId) {
        // First message of a brand-new session: adopt the id and let the
        // history query take over rendering (it'll include this turn).
        setSessionId(newSid);
        setLive([]);
        void sessions.refetch();
      } else {
        setLive((m) => [...m, { id: `a-${Date.now()}`, role: 'assistant', text: text ?? '(no text in reply)' }]);
        void history.refetch();
      }
    } catch (err) {
      setLive((m) => [...m, { id: `s-${Date.now()}`, role: 'system', text: err instanceof Error ? err.message : String(err) }]);
    }
  };

  return (
    <div className="animate-fade-in flex flex-col h-[calc(100vh-7rem)]">
      <PageHeader
        title="berry-admin"
        subtitle="Chat with the cluster admin agent. Conversations persist as SDK sessions — pick a past session to continue it."
        actions={<Button onClick={() => selectSession(null)}>New chat</Button>}
      />

      <div className="flex-1 grid grid-cols-[220px_1fr] gap-3 min-h-0">
        {/* Session list — durable, survives tab switches */}
        <Card bordered bodyStyle={{ padding: 8 }} className="overflow-y-auto">
          <div className="text-xs font-semibold uppercase tracking-wider px-2 py-1" style={{ color: 'var(--color-text-3)' }}>
            Sessions
          </div>
          {sessions.isLoading ? (
            <Spinner />
          ) : sessions.data && sessions.data.length > 0 ? (
            <ul className="space-y-0.5">
              {sessions.data.map((s) => (
                <li key={s.id}>
                  <button
                    className="w-full text-left px-2 py-1.5 rounded text-xs transition-colors"
                    style={sessionId === s.id
                      ? { background: 'var(--color-fill-2)', color: 'var(--color-text-1)' }
                      : { color: 'var(--color-text-2)' }}
                    onClick={() => selectSession(s.id)}
                  >
                    <div className="font-mono truncate">{s.title || s.id}</div>
                    <div className="mt-0.5" style={{ color: 'var(--color-text-4)' }}>{relativeTime(s.lastActiveAt)} · {s.messageCount ?? 0} msg</div>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <div className="text-xs px-2 py-3" style={{ color: 'var(--color-text-4)' }}>No sessions yet. Send a message to start one.</div>
          )}
        </Card>

        {/* Conversation */}
        <div className="flex flex-col min-h-0">
          <Card bordered bodyStyle={{ padding: 16 }} className="flex-1 overflow-y-auto mb-3">
            <div ref={containerRef} className="space-y-3 h-full">
              {history.isLoading && sessionId && <Spinner />}
              {messages.length === 0 && !history.isLoading && (
                <div className="text-center text-sm py-12" style={{ color: 'var(--color-text-3)' }}>
                  <div className="text-4xl mb-2">✦</div>
                  Ask me anything: <em>"how is the cluster?"</em> · <em>"drain worker X"</em> · <em>"how do I add a worker?"</em>
                </div>
              )}
              {messages.map((m) => (
                <div key={m.id} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                  <div
                    className="max-w-[80%] px-4 py-2.5 rounded-2xl text-sm whitespace-pre-wrap"
                    style={
                      m.role === 'user'
                        ? { background: 'rgb(var(--arcoblue-6))', color: '#fff', borderBottomRightRadius: 4 }
                        : m.role === 'assistant'
                        ? { background: 'var(--color-fill-2)', color: 'var(--color-text-1)', borderBottomLeftRadius: 4 }
                        : { background: 'var(--color-warning-light-1)', color: 'rgb(var(--orange-7))', fontStyle: 'italic', fontSize: 12 }
                    }
                  >
                    {m.text}
                  </div>
                </div>
              ))}
              {send.isPending && (
                <div className="flex justify-start">
                  <div className="rounded-2xl px-4 py-2.5 text-sm italic" style={{ background: 'var(--color-fill-2)', color: 'var(--color-text-3)', borderBottomLeftRadius: 4 }}>
                    thinking…
                  </div>
                </div>
              )}
            </div>
          </Card>

          <div className="flex gap-2">
            <Input.TextArea
              value={draft}
              onChange={setDraft}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  void submit();
                }
              }}
              placeholder="Type a message and Cmd/Ctrl+Enter to send…"
              rows={3}
              style={{ flex: 1, resize: 'none' }}
            />
            <Button
              type="primary"
              onClick={() => { void submit(); }}
              disabled={!draft.trim() || send.isPending}
              style={{ height: 'auto', paddingLeft: 24, paddingRight: 24 }}
            >
              Send
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Rebuild chat bubbles from a session's durable event log. */
function eventsToMessages(events: RawSessionEvent[]): Message[] {
  const out: Message[] = [];
  for (const ev of events) {
    if (ev.type === 'user_message') {
      out.push({ id: ev.id, role: 'user', text: contentToText((ev as { content?: unknown }).content) });
    } else if (ev.type === 'assistant_message') {
      const text = contentToText((ev as { content?: unknown }).content);
      if (text) out.push({ id: ev.id, role: 'assistant', text });
    }
  }
  return out;
}

/** Flatten a SessionEvent content (string | ContentBlock[]) to display text. */
function contentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (b && typeof b === 'object' && (b as { type?: string }).type === 'text'
        ? String((b as { text?: string }).text ?? '')
        : ''))
      .filter(Boolean)
      .join('');
  }
  return '';
}

interface SendResponseLike {
  result?: {
    assistantMessage?: { content?: string };
    result?: { text?: string };
  };
}
function extractText(r: SendResponseLike): string | null {
  const inner = r.result?.result;
  if (typeof inner?.text === 'string') return inner.text;
  if (typeof r.result?.assistantMessage?.content === 'string') return r.result.assistantMessage.content;
  return null;
}
