import { useRef, useState } from 'react';
import { useAdminChat } from '../api/queries.js';
import { PageHeader } from '../components/Page.js';

interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system';
  text: string;
  ts: number;
}

export function AdminChatPage() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState('');
  const send = useAdminChat();
  const containerRef = useRef<HTMLDivElement>(null);

  const submit = async () => {
    const prompt = draft.trim();
    if (!prompt) return;
    const userMsg: Message = { id: `u-${Date.now()}`, role: 'user', text: prompt, ts: Date.now() };
    setMessages((m) => [...m, userMsg]);
    setDraft('');

    try {
      const resp = await send.mutateAsync(prompt);
      const text = extractText(resp);
      const reply: Message = {
        id: `a-${Date.now()}`,
        role: 'assistant',
        text: text ?? '(no text in reply)',
        ts: Date.now(),
      };
      setMessages((m) => [...m, reply]);
    } catch (err) {
      setMessages((m) => [
        ...m,
        {
          id: `s-${Date.now()}`,
          role: 'system',
          text: err instanceof Error ? err.message : String(err),
          ts: Date.now(),
        },
      ]);
    } finally {
      requestAnimationFrame(() => {
        const el = containerRef.current;
        if (el) el.scrollTop = el.scrollHeight;
      });
    }
  };

  return (
    <div className="animate-fade-in flex flex-col h-[calc(100vh-7rem)]">
      <PageHeader
        title="berry-admin"
        subtitle="Chat with the auto-spawned cluster admin agent. It can answer cluster questions and execute operator actions on your behalf."
      />

      <div
        ref={containerRef}
        className="flex-1 overflow-y-auto card mb-3 p-4 space-y-3"
      >
        {messages.length === 0 && (
          <div className="text-center text-sm text-ink-500 dark:text-ink-400 py-12">
            <div className="text-4xl mb-2">✦</div>
            Ask me anything: <em>"how is the cluster?"</em> ·{' '}
            <em>"drain worker X"</em> · <em>"how do I add a worker?"</em>
          </div>
        )}
        {messages.map((m) => (
          <div
            key={m.id}
            className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}
          >
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
  );
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
