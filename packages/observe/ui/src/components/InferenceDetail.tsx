import { useState } from 'react';
import { ArrowLeft, Check, X, Edit, Clock, Cpu, MessageSquare, Wrench } from 'lucide-react';
import { useObserveApi } from '../hooks/useObserve';
import { MessageBlock } from './blocks/MessageBlock';

interface Props {
  baseUrl: string;
  inferenceId: string;
  onBack?: () => void;
}

type ViewTab = 'berry' | 'wire-request' | 'wire-response';

export function InferenceDetail({ baseUrl, inferenceId, onBack }: Props) {
  const { data, loading } = useObserveApi<any>(baseUrl, `/inferences/${inferenceId}`);
  const [tab, setTab] = useState<ViewTab>('berry');

  if (loading) return <div className="p-4 text-gray-400 dark:text-gray-500">Loading...</div>;
  if (!data) return <div className="p-4 text-gray-400 dark:text-gray-500">Not found</div>;

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center gap-3">
        {onBack && (
          <button onClick={onBack} className="p-1 hover:bg-gray-100 dark:hover:bg-gray-700 rounded">
            <ArrowLeft size={20} className="text-gray-600 dark:text-gray-300" />
          </button>
        )}
        <h3 className="text-lg font-bold text-gray-800 dark:text-gray-100">Inference Detail</h3>
        <span className="text-xs font-mono text-gray-400 dark:text-gray-500">{inferenceId}</span>
      </div>

      {/* Meta row */}
      <div className="flex flex-wrap gap-3 text-sm">
        <MetaBadge icon={<Cpu size={14} />} label={data.model} />
        <MetaBadge icon={<Clock size={14} />} label={`${data.latencyMs}ms`} />
        <MetaBadge icon={<MessageSquare size={14} />} label={`${data.messageCount} msgs`} />
        <MetaBadge icon={<Wrench size={14} />} label={`${data.toolDefCount} tools`} />
        <StopBadge reason={data.stopReason} />
        <span className="px-2 py-1 bg-gray-100 dark:bg-gray-700 rounded text-gray-600 dark:text-gray-300 text-xs">
          {data.provider}
        </span>
      </div>

      {/* Token breakdown */}
      <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-4">
        <h4 className="text-sm font-semibold text-gray-600 dark:text-gray-300 mb-3">Token Breakdown</h4>
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3 text-center">
          <TokenCard label="Input" value={data.inputTokens} />
          <TokenCard label="Output" value={data.outputTokens} />
          <TokenCard label="Cache Read" value={data.cacheReadTokens} color="green" />
          <TokenCard label="Cache Write" value={data.cacheWriteTokens} color="blue" />
          <TokenCard label="Cost" value={`$${data.totalCost?.toFixed(6)}`} />
        </div>
      </div>

      {/* Protocol tabs */}
      <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden">
        <div className="flex border-b border-gray-200 dark:border-gray-700">
          <TabBtn active={tab === 'berry'} onClick={() => setTab('berry')}>Berry Format</TabBtn>
          <TabBtn active={tab === 'wire-request'} onClick={() => setTab('wire-request')}>
            {data.provider === 'anthropic' ? 'Anthropic' : 'OpenAI'} Request
          </TabBtn>
          <TabBtn active={tab === 'wire-response'} onClick={() => setTab('wire-response')}>
            {data.provider === 'anthropic' ? 'Anthropic' : 'OpenAI'} Response
          </TabBtn>
        </div>

        <div className="p-4 max-h-[600px] overflow-y-auto">
          {tab === 'berry' && (
            <div className="space-y-4">
              {/* System Prompt */}
              {data.requestSystem && (
                <CollapsibleSection title={`System Prompt (${safeParse(data.requestSystem)?.length ?? 0} blocks)`}>
                  <JsonView data={safeParse(data.requestSystem)} />
                </CollapsibleSection>
              )}

              {/* Messages */}
              {data.requestMessages && (
                <CollapsibleSection title={`Messages (${safeParse(data.requestMessages)?.length ?? 0} turns)`}>
                  <MessageList messages={safeParse(data.requestMessages)} />
                </CollapsibleSection>
              )}

              {/* Tool Definitions */}
              {data.requestTools && (
                <CollapsibleSection title={`Tool Definitions (${safeParse(data.requestTools)?.length ?? 0})`}>
                  <ToolDefList tools={safeParse(data.requestTools)} />
                </CollapsibleSection>
              )}

              {/* Response */}
              {data.responseContent && (
                <CollapsibleSection title="Response Content" defaultOpen>
                  <ResponseContent content={safeParse(data.responseContent)} />
                </CollapsibleSection>
              )}
            </div>
          )}

          {tab === 'wire-request' && (
            <JsonView data={safeParse(data.providerRequest)} fallback="Wire format request not available" />
          )}

          {tab === 'wire-response' && (
            <JsonView data={safeParse(data.providerResponse)} fallback="Wire format response not available" />
          )}
        </div>
      </div>

      {/* Guard decisions */}
      {data.guardDecisions?.length > 0 && (
        <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-4">
          <h4 className="text-sm font-semibold text-gray-600 dark:text-gray-300 mb-3">Guard Decisions ({data.guardDecisions.length})</h4>
          <div className="space-y-2">
            {data.guardDecisions.map((gd: any) => (
              <div key={gd.id} className={`flex items-center gap-3 px-3 py-2 rounded-lg text-sm ${
                gd.decision === 'allow' ? 'bg-green-50 dark:bg-green-900/20' : gd.decision === 'deny' ? 'bg-red-50 dark:bg-red-900/20' : 'bg-yellow-50 dark:bg-yellow-900/20'
              }`}>
                {gd.decision === 'allow' ? <Check size={16} className="text-green-600 dark:text-green-400" /> :
                 gd.decision === 'deny' ? <X size={16} className="text-red-600 dark:text-red-400" /> :
                 <Edit size={16} className="text-yellow-600 dark:text-yellow-400" />}
                <span className="font-mono text-gray-800 dark:text-gray-200">{gd.toolName}</span>
                <span className="text-gray-500 dark:text-gray-400">{gd.decision}</span>
                {gd.reason && <span className="text-red-600 dark:text-red-400">— {gd.reason}</span>}
                <span className="text-gray-400 dark:text-gray-500 ml-auto">{gd.durationMs}ms</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Tool calls */}
      {data.toolCalls?.length > 0 && (
        <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-4">
          <h4 className="text-sm font-semibold text-gray-600 dark:text-gray-300 mb-3">Tool Calls ({data.toolCalls.length})</h4>
          <div className="space-y-2">
            {data.toolCalls.map((tc: any, i: number) => (
              <div key={i} className={`px-3 py-2 rounded-lg text-sm ${tc.isError ? 'bg-red-50 dark:bg-red-900/20' : 'bg-gray-50 dark:bg-gray-700/50'}`}>
                <div className="flex items-center gap-2">
                  <span className="font-mono font-medium text-gray-800 dark:text-gray-200">{tc.name}</span>
                  <span className="text-gray-400 dark:text-gray-500">{tc.durationMs}ms</span>
                  {tc.isError && <span className="text-red-500 dark:text-red-400 text-xs">error</span>}
                </div>
                <div className="text-xs text-gray-500 dark:text-gray-400 mt-1 font-mono truncate">{tc.input}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ===== Sub-components =====

function MetaBadge({ icon, label }: { icon: React.ReactNode; label: string }) {
  return (
    <span className="flex items-center gap-1 px-2 py-1 bg-gray-100 dark:bg-gray-700 rounded text-xs text-gray-600 dark:text-gray-300">
      {icon} {label}
    </span>
  );
}

function StopBadge({ reason }: { reason: string }) {
  const c: Record<string, string> = {
    end_turn: 'bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-400',
    tool_use: 'bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-400',
    max_tokens: 'bg-orange-100 dark:bg-orange-900/40 text-orange-700 dark:text-orange-400',
  };
  return <span className={`text-xs px-2 py-1 rounded-full font-medium ${c[reason] ?? 'bg-gray-100 dark:bg-gray-700'}`}>{reason}</span>;
}

function TokenCard({ label, value, color }: { label: string; value: number | string; color?: string }) {
  const textColor = color === 'green' ? 'text-green-600 dark:text-green-400' : color === 'blue' ? 'text-blue-600 dark:text-blue-400' : 'text-gray-800 dark:text-gray-100';
  return (
    <div>
      <div className="text-xs text-gray-500 dark:text-gray-400">{label}</div>
      <div className={`text-lg font-bold ${textColor}`}>
        {typeof value === 'number' ? value.toLocaleString() : value}
      </div>
    </div>
  );
}

function TabBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
        active ? 'border-indigo-500 text-indigo-600 dark:text-indigo-400' : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300'
      }`}
    >
      {children}
    </button>
  );
}

function CollapsibleSection({ title, children, defaultOpen }: { title: string; children: React.ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen ?? false);
  return (
    <div className="border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between px-3 py-2 bg-gray-50 dark:bg-gray-700/50 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700"
      >
        {title}
        <span className="text-gray-400 dark:text-gray-500">{open ? '▼' : '▶'}</span>
      </button>
      {open && <div className="p-3 text-sm">{children}</div>}
    </div>
  );
}

function JsonView({ data, fallback }: { data: unknown; fallback?: string }) {
  if (data == null) return <div className="text-gray-400 dark:text-gray-500 text-sm">{fallback ?? 'No data'}</div>;
  return (
    <pre className="text-xs font-mono bg-gray-50 dark:bg-gray-900/50 p-3 rounded-lg overflow-x-auto max-h-[400px] overflow-y-auto whitespace-pre-wrap break-all text-gray-800 dark:text-gray-200">
      {JSON.stringify(data, null, 2)}
    </pre>
  );
}

const ROLE_STYLES: Record<string, { bg: string; accent: string; label: string }> = {
  user:      { bg: 'bg-blue-50 dark:bg-blue-900/20',   accent: 'text-blue-600 dark:text-blue-400',   label: 'User' },
  assistant: { bg: 'bg-green-50 dark:bg-green-900/20',  accent: 'text-green-600 dark:text-green-400', label: 'Assistant' },
  system:    { bg: 'bg-gray-50 dark:bg-gray-800/50',    accent: 'text-gray-500 dark:text-gray-400',   label: 'System' },
};

function MessageList({ messages }: { messages: any[] | null }) {
  if (!messages) return <div className="text-gray-400 dark:text-gray-500">No messages</div>;
  return (
    <div className="space-y-3">
      {messages.map((msg: any, i: number) => {
        const style = ROLE_STYLES[msg.role] ?? ROLE_STYLES.user;
        return (
          <div key={i} className={`rounded-lg overflow-hidden border border-gray-200 dark:border-gray-700 ${style.bg}`}>
            {/* Role header */}
            <div className={`px-3 py-1.5 text-xs font-semibold ${style.accent} border-b border-gray-200/60 dark:border-gray-700/60`}>
              {style.label}
            </div>
            {/* Content blocks */}
            <div className="px-3 py-2 space-y-2">
              {typeof msg.content === 'string' ? (
                <div className="text-sm text-gray-800 dark:text-gray-200 whitespace-pre-wrap break-words">{msg.content}</div>
              ) : Array.isArray(msg.content) ? (
                msg.content.map((block: any, j: number) => (
                  <MessageBlock key={j} block={block} />
                ))
              ) : (
                <pre className="text-xs font-mono text-gray-600 dark:text-gray-400 overflow-x-auto">{JSON.stringify(msg.content, null, 2)}</pre>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function ToolDefList({ tools }: { tools: any[] | null }) {
  if (!tools) return null;
  return (
    <div className="flex flex-wrap gap-2">
      {tools.map((t: any, i: number) => (
        <span key={i} className="px-2 py-1 bg-gray-100 dark:bg-gray-700 rounded text-xs font-mono text-gray-700 dark:text-gray-300">{t.name}</span>
      ))}
    </div>
  );
}

function ResponseContent({ content }: { content: any }) {
  if (!content) return <div className="text-gray-400 dark:text-gray-500">No response</div>;
  // Berry response content is an array of blocks (text, tool_use, thinking)
  if (Array.isArray(content)) {
    return (
      <div className="space-y-2">
        {content.map((block: any, i: number) => (
          <MessageBlock key={i} block={block} />
        ))}
      </div>
    );
  }
  // Fallback: string or unknown shape
  if (typeof content === 'string') {
    return <div className="text-sm text-gray-800 dark:text-gray-200 whitespace-pre-wrap">{content}</div>;
  }
  return (
    <pre className="text-xs font-mono bg-gray-50 dark:bg-gray-900/50 p-3 rounded-lg overflow-x-auto max-h-[400px] overflow-y-auto whitespace-pre-wrap break-all text-gray-800 dark:text-gray-200">
      {JSON.stringify(content, null, 2)}
    </pre>
  );
}

function safeParse(json: string | null): any {
  if (!json) return null;
  try { return JSON.parse(json); } catch { return null; }
}
