import { useEffect, useMemo, useRef, useState } from 'react';
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
        actions={
          <button type="button" className="btn btn-default" onClick={() => selectSession(null)}>
            New chat
          </button>
        }
      />

      <div className="flex-1 grid grid-cols-[220px_1fr] gap-3 min-h-0">
        {/* Session list — durable, survives tab switches */}
        <div className="card overflow-y-auto p-2">
          <div className="text-xs font-semibold uppercase tracking-wider text-ink-500 dark:text-ink-400 px-2 py-1">
            Sessions
          </div>
          {sessions.isLoading ? (
            <Spinner />
          ) : sessions.data && sessions.data.length > 0 ? (
            <ul className="space-y-0.5">
              {sessions.data.map((s) => (
                <li key={s.id}>
                  <button
                    className={`w-full text-left px-2 py-1.5 rounded text-xs transition-colors ${
                      sessionId === s.id
                        ? 'bg-berry-50 dark:bg-berry-950/30 text-ink-900 dark:text-ink-100'
                        : 'hover:bg-ink-50 dark:hover:bg-ink-900 text-ink-600 dark:text-ink-400'
                    }`}
                    onClick={() => selectSession(s.id)}
                  >
                    <div className="font-mono truncate">{s.title || s.id}</div>
                    <div className="text-ink-400 mt-0.5">{relativeTime(s.lastActiveAt)} · {s.messageCount ?? 0} msg</div>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <div className="text-xs text-ink-400 px-2 py-3">No sessions yet. Send a message to start one.</div>
          )}
        </div>

        {/* Conversation */}
        <div className="flex flex-col min-h-0">
          <div ref={containerRef} className="flex-1 overflow-y-auto card mb-3 p-4 space-y-3">
            {history.isLoading && sessionId && <Spinner />}
            {messages.length === 0 && !history.isLoading && (
              <div className="text-center text-sm text-ink-500 dark:text-ink-400 py-12">
                <div className="text-4xl mb-2">✦</div>
                Ask me anything: <em>"how is the cluster?"</em> · <em>"drain worker X"</em> · <em>"how do I add a worker?"</em>
              </div>
            )}
            {messages.map((m) => (
              <div key={m.id} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                <div
                  className={`max-w-[80%] px-4 py-2.5 rounded-2xl text-sm whitespace-pre-wrap ${
                    m.role === 'user'
                      ? 'bg-berry-600 text-white rounded-br-sm'
                      : m.role === 'assistant'
                      ? 'bg-ink-100 text-ink-900 rounded-bl-sm dark:bg-ink-800 dark:text-ink-100'
                      : 'bg-amber-50 text-amber-800 text-xs italic dark:bg-amber-950/40 dark:text-amber-300'
                  }`}
                >
                  {m.text}
                </div>
              </div>
            ))}
            {send.isPending && (
              <div className="flex justify-start">
                <div className="bg-ink-100 dark:bg-ink-800 rounded-2xl rounded-bl-sm px-4 py-2.5 text-sm text-ink-500 dark:text-ink-400 italic">
                  thinking…
                </div>
              </div>
            )}
          </div>

          <div className="flex gap-2">
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  void submit();
                }
              }}
              placeholder="Type a message and Cmd/Ctrl+Enter to send…"
              rows={3}
              className="input flex-1 font-sans resize-none"
            />
            <button
              type="button"
              onClick={() => { void submit(); }}
              disabled={!draft.trim() || send.isPending}
              className="btn btn-primary px-6 self-stretch"
            >
              Send
            </button>
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
