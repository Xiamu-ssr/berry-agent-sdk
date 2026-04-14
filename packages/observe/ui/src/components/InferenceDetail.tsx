import { useState } from 'react';
import { ArrowLeft, Check, X, Edit, Clock, Cpu, MessageSquare, Wrench } from 'lucide-react';
import { useObserveApi } from '../hooks/useObserve';

interface Props {
  baseUrl: string;
  inferenceId: string;
  onBack?: () => void;
}

type ViewTab = 'berry' | 'wire-request' | 'wire-response';

export function InferenceDetail({ baseUrl, inferenceId, onBack }: Props) {
  const { data, loading } = useObserveApi<any>(baseUrl, `/inferences/${inferenceId}`);
  const [tab, setTab] = useState<ViewTab>('berry');

  if (loading) return <div className="p-4 text-gray-400">Loading...</div>;
  if (!data) return <div className="p-4 text-gray-400">Not found</div>;

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center gap-3">
        {onBack && (
          <button onClick={onBack} className="p-1 hover:bg-gray-100 rounded">
            <ArrowLeft size={20} />
          </button>
        )}
        <h3 className="text-lg font-bold text-gray-800">Inference Detail</h3>
        <span className="text-xs font-mono text-gray-400">{inferenceId}</span>
      </div>

      {/* Meta row */}
      <div className="flex flex-wrap gap-3 text-sm">
        <MetaBadge icon={<Cpu size={14} />} label={data.model} />
        <MetaBadge icon={<Clock size={14} />} label={`${data.latencyMs}ms`} />
        <MetaBadge icon={<MessageSquare size={14} />} label={`${data.messageCount} msgs`} />
        <MetaBadge icon={<Wrench size={14} />} label={`${data.toolDefCount} tools`} />
        <StopBadge reason={data.stopReason} />
        <span className="px-2 py-1 bg-gray-100 rounded text-gray-600 text-xs">
          {data.provider}
        </span>
      </div>

      {/* Token breakdown */}
      <div className="bg-white rounded-xl border border-gray-200 p-4">
        <h4 className="text-sm font-semibold text-gray-600 mb-3">Token Breakdown</h4>
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3 text-center">
          <TokenCard label="Input" value={data.inputTokens} />
          <TokenCard label="Output" value={data.outputTokens} />
          <TokenCard label="Cache Read" value={data.cacheReadTokens} color="green" />
          <TokenCard label="Cache Write" value={data.cacheWriteTokens} color="blue" />
          <TokenCard label="Cost" value={`$${data.totalCost?.toFixed(6)}`} />
        </div>
      </div>

      {/* Protocol tabs */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="flex border-b border-gray-200">
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
                  <JsonView data={safeParse(data.responseContent)} />
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
        <div className="bg-white rounded-xl border border-gray-200 p-4">
          <h4 className="text-sm font-semibold text-gray-600 mb-3">Guard Decisions ({data.guardDecisions.length})</h4>
          <div className="space-y-2">
            {data.guardDecisions.map((gd: any) => (
              <div key={gd.id} className={`flex items-center gap-3 px-3 py-2 rounded-lg text-sm ${
                gd.decision === 'allow' ? 'bg-green-50' : gd.decision === 'deny' ? 'bg-red-50' : 'bg-yellow-50'
              }`}>
                {gd.decision === 'allow' ? <Check size={16} className="text-green-600" /> :
                 gd.decision === 'deny' ? <X size={16} className="text-red-600" /> :
                 <Edit size={16} className="text-yellow-600" />}
                <span className="font-mono">{gd.toolName}</span>
                <span className="text-gray-500">{gd.decision}</span>
                {gd.reason && <span className="text-red-600">— {gd.reason}</span>}
                <span className="text-gray-400 ml-auto">{gd.durationMs}ms</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Tool calls */}
      {data.toolCalls?.length > 0 && (
        <div className="bg-white rounded-xl border border-gray-200 p-4">
          <h4 className="text-sm font-semibold text-gray-600 mb-3">Tool Calls ({data.toolCalls.length})</h4>
          <div className="space-y-2">
            {data.toolCalls.map((tc: any, i: number) => (
              <div key={i} className={`px-3 py-2 rounded-lg text-sm ${tc.isError ? 'bg-red-50' : 'bg-gray-50'}`}>
                <div className="flex items-center gap-2">
                  <span className="font-mono font-medium">{tc.name}</span>
                  <span className="text-gray-400">{tc.durationMs}ms</span>
                  {tc.isError && <span className="text-red-500 text-xs">error</span>}
                </div>
                <div className="text-xs text-gray-500 mt-1 font-mono truncate">{tc.input}</div>
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
    <span className="flex items-center gap-1 px-2 py-1 bg-gray-100 rounded text-xs text-gray-600">
      {icon} {label}
    </span>
  );
}

function StopBadge({ reason }: { reason: string }) {
  const c = { end_turn: 'bg-green-100 text-green-700', tool_use: 'bg-blue-100 text-blue-700', max_tokens: 'bg-orange-100 text-orange-700' };
  return <span className={`text-xs px-2 py-1 rounded-full font-medium ${c[reason as keyof typeof c] ?? 'bg-gray-100'}`}>{reason}</span>;
}

function TokenCard({ label, value, color }: { label: string; value: number | string; color?: string }) {
  const textColor = color === 'green' ? 'text-green-600' : color === 'blue' ? 'text-blue-600' : 'text-gray-800';
  return (
    <div>
      <div className="text-xs text-gray-500">{label}</div>
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
        active ? 'border-indigo-500 text-indigo-600' : 'border-transparent text-gray-500 hover:text-gray-700'
      }`}
    >
      {children}
    </button>
  );
}

function CollapsibleSection({ title, children, defaultOpen }: { title: string; children: React.ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen ?? false);
  return (
    <div className="border border-gray-200 rounded-lg overflow-hidden">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between px-3 py-2 bg-gray-50 text-sm font-medium text-gray-700 hover:bg-gray-100"
      >
        {title}
        <span className="text-gray-400">{open ? '▼' : '▶'}</span>
      </button>
      {open && <div className="p-3 text-sm">{children}</div>}
    </div>
  );
}

function JsonView({ data, fallback }: { data: unknown; fallback?: string }) {
  if (data == null) return <div className="text-gray-400 text-sm">{fallback ?? 'No data'}</div>;
  return (
    <pre className="text-xs font-mono bg-gray-50 p-3 rounded-lg overflow-x-auto max-h-[400px] overflow-y-auto whitespace-pre-wrap break-all">
      {JSON.stringify(data, null, 2)}
    </pre>
  );
}

function MessageList({ messages }: { messages: any[] | null }) {
  if (!messages) return <div className="text-gray-400">No messages</div>;
  return (
    <div className="space-y-2">
      {messages.map((msg: any, i: number) => (
        <div key={i} className={`p-2 rounded-lg text-sm ${msg.role === 'user' ? 'bg-blue-50' : 'bg-green-50'}`}>
          <div className="font-medium text-xs text-gray-500 mb-1">{msg.role}</div>
          {typeof msg.content === 'string' ? (
            <div className="whitespace-pre-wrap break-words">{msg.content.slice(0, 500)}{msg.content.length > 500 ? '...' : ''}</div>
          ) : (
            <div className="font-mono text-xs">{JSON.stringify(msg.content).slice(0, 300)}...</div>
          )}
        </div>
      ))}
    </div>
  );
}

function ToolDefList({ tools }: { tools: any[] | null }) {
  if (!tools) return null;
  return (
    <div className="flex flex-wrap gap-2">
      {tools.map((t: any, i: number) => (
        <span key={i} className="px-2 py-1 bg-gray-100 rounded text-xs font-mono">{t.name}</span>
      ))}
    </div>
  );
}

function safeParse(json: string | null): any {
  if (!json) return null;
  try { return JSON.parse(json); } catch { return null; }
}
