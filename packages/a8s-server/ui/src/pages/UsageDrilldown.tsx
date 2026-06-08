import { useState } from 'react';
import { Modal, Breadcrumb, Table, Tag, Tabs, Spin, Empty } from '@arco-design/web-react';
import {
  useUsageSessions, useUsageTurns, useUsageInferences, useUsageInferenceDetail,
  type UsageSession, type UsageTurn, type UsageInference, type UsageInferenceDetail,
} from '../api/queries.js';

// ============================================================
// 消耗钻取 — Agent → Session → Engine Loop(turn) → Inference → 完整推理
// ============================================================
// The bottom rungs of the consumption layering, made navigable. Each level is
// proxied to the agent's owning worker reading its observe.db. The atom is one
// inference, shown in full: system prompt, tool list, the messages it saw, the
// response it produced, the tool calls it made, plus cache/token/timing. All
// data already recorded — this only surfaces it.

function money(n: number): string { return `$${n.toFixed(n < 1 ? 4 : 2)}`; }
function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}
function shortModel(m: string): string { return m.replace(/^.*\//, '').replace(/-\d{8}$/, ''); }
function when(ms: number | null): string {
  if (!ms) return '—';
  // Stable, locale-free UTC stamp — avoids the page jumping between zones.
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCMonth() + 1}/${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

type Level =
  | { kind: 'sessions' }
  | { kind: 'turns'; sessionId: string }
  | { kind: 'inferences'; sessionId: string; turnId: string }
  | { kind: 'inference'; sessionId: string; turnId: string; inferenceId: string };

/**
 * The drill body — breadcrumb + the four navigable rungs (session → engine
 * loop → inference → full inference). Rendered both inside the modal (from the
 * 消耗 page) and inline on the first-class 日志 page. The atom is one inference,
 * shown in full; everything above it is a rollup. All data already recorded by
 * observe — this only surfaces it.
 */
export function DrilldownBody({ agentId }: { agentId: string }) {
  const [stack, setStack] = useState<Level[]>([{ kind: 'sessions' }]);
  const level = stack[stack.length - 1];
  const push = (l: Level) => setStack((s) => [...s, l]);
  const popTo = (i: number) => setStack((s) => s.slice(0, i + 1));

  // Reset to the session root when the agent changes (page reuse).
  const [boundAgent, setBoundAgent] = useState(agentId);
  if (boundAgent !== agentId) {
    setBoundAgent(agentId);
    setStack([{ kind: 'sessions' }]);
  }

  return (
    <>
      <Breadcrumb className="mb-4">
        {stack.map((l, i) => (
          <Breadcrumb.Item
            key={i}
            className={i < stack.length - 1 ? 'cursor-pointer' : ''}
            onClick={i < stack.length - 1 ? () => popTo(i) : undefined}
          >
            {l.kind === 'sessions' && '会话'}
            {l.kind === 'turns' && 'Engine Loop'}
            {l.kind === 'inferences' && '推理'}
            {l.kind === 'inference' && '推理详情'}
          </Breadcrumb.Item>
        ))}
      </Breadcrumb>

      <div style={{ minHeight: 320, maxHeight: '70vh', overflowY: 'auto' }}>
        {level.kind === 'sessions' && (
          <SessionsLevel agentId={agentId} onPick={(sessionId) => push({ kind: 'turns', sessionId })} />
        )}
        {level.kind === 'turns' && (
          <TurnsLevel agentId={agentId} sessionId={level.sessionId}
            onPick={(turnId) => push({ kind: 'inferences', sessionId: level.sessionId, turnId })} />
        )}
        {level.kind === 'inferences' && (
          <InferencesLevel agentId={agentId} turnId={level.turnId}
            onPick={(inferenceId) => push({ kind: 'inference', sessionId: level.sessionId, turnId: level.turnId, inferenceId })} />
        )}
        {level.kind === 'inference' && (
          <InferenceLevel agentId={agentId} inferenceId={level.inferenceId} />
        )}
      </div>
    </>
  );
}

/** The drill-down modal, opened from a per-agent row on the 消耗 page. */
export function UsageDrilldown({ agentId, onClose }: { agentId: string; onClose: () => void }) {
  return (
    <Modal
      visible
      title={<span>消耗钻取 · <code className="font-mono text-sm">{agentId}</code></span>}
      onCancel={onClose}
      footer={null}
      style={{ width: 960, top: 40 }}
    >
      <DrilldownBody agentId={agentId} />
    </Modal>
  );
}

function Loading() {
  return <div className="flex justify-center py-12"><Spin /></div>;
}

// ---- Level 1: sessions ----
function SessionsLevel({ agentId, onPick }: { agentId: string; onPick: (sessionId: string) => void }) {
  const q = useUsageSessions(agentId);
  if (!q.data) return <Loading />;
  if (q.data.length === 0) return <Empty description="该 Agent 还没有会话记录" />;
  return (
    <Table
      rowKey="id"
      size="small"
      pagination={{ pageSize: 12, hideOnSinglePage: true, sizeCanChange: false }}
      data={q.data}
      onRow={(row: UsageSession) => ({ onClick: () => onPick(row.id), style: { cursor: 'pointer' } })}
      columns={[
        { title: '会话', dataIndex: 'id', render: (v: string) => <code className="font-mono text-xs">{v.slice(0, 12)}</code> },
        { title: '状态', dataIndex: 'status', render: (v: string) => <Tag size="small" color={v === 'active' ? 'green' : undefined}>{v}</Tag> },
        { title: '推理', dataIndex: 'llmCallCount', align: 'right' as const, render: (v: number) => <Mono v={v} /> },
        { title: '工具', dataIndex: 'toolCallCount', align: 'right' as const, render: (v: number) => <Mono v={v} /> },
        { title: '开始', dataIndex: 'startTime', align: 'right' as const, render: (v: number) => <Dim v={when(v)} /> },
        { title: '成本', dataIndex: 'totalCost', align: 'right' as const, render: (v: number) => <Cost v={v} /> },
      ]}
    />
  );
}

// ---- Level 2: turns (engine loops) ----
function TurnsLevel({ agentId, sessionId, onPick }: { agentId: string; sessionId: string; onPick: (turnId: string) => void }) {
  const q = useUsageTurns(agentId, sessionId);
  if (!q.data) return <Loading />;
  if (q.data.length === 0) return <Empty description="该会话没有 Engine Loop 记录" />;
  return (
    <Table
      rowKey="id"
      size="small"
      pagination={{ pageSize: 12, hideOnSinglePage: true, sizeCanChange: false }}
      data={q.data}
      onRow={(row: UsageTurn) => ({ onClick: () => onPick(row.id), style: { cursor: 'pointer' } })}
      columns={[
        {
          title: 'Prompt', dataIndex: 'prompt',
          render: (v: string | null) => v
            ? <span className="text-xs" style={{ color: 'var(--color-text-2)' }}>{v.length > 60 ? v.slice(0, 60) + '…' : v}</span>
            : <span style={{ color: 'var(--color-text-4)' }}>—</span>,
        },
        { title: '状态', dataIndex: 'status', render: (v: string, r: UsageTurn) => (
          <span className="flex items-center gap-1">
            <Tag size="small" color={v === 'completed' ? 'green' : v === 'active' ? 'arcoblue' : undefined}>{v}</Tag>
            {r.recoveredFromCrash && <Tag size="small" color="orange">恢复</Tag>}
          </span>
        ) },
        { title: '推理', dataIndex: 'llmCallCount', align: 'right' as const, render: (v: number) => <Mono v={v} /> },
        { title: '工具', dataIndex: 'toolCallCount', align: 'right' as const, render: (v: number) => <Mono v={v} /> },
        { title: '开始', dataIndex: 'startTime', align: 'right' as const, render: (v: number) => <Dim v={when(v)} /> },
        { title: '成本', dataIndex: 'totalCost', align: 'right' as const, render: (v: number) => <Cost v={v} /> },
      ]}
    />
  );
}

// ---- Level 3: inferences in a turn ----
function InferencesLevel({ agentId, turnId, onPick }: { agentId: string; turnId: string; onPick: (inferenceId: string) => void }) {
  const q = useUsageInferences(agentId, turnId);
  if (!q.data) return <Loading />;
  if (q.data.length === 0) return <Empty description="该 Engine Loop 没有推理记录" />;
  return (
    <Table
      rowKey="id"
      size="small"
      pagination={{ pageSize: 15, hideOnSinglePage: true, sizeCanChange: false }}
      data={q.data}
      onRow={(row: UsageInference) => ({ onClick: () => onPick(row.id), style: { cursor: 'pointer' } })}
      columns={[
        { title: '模型', dataIndex: 'model', render: (v: string) => <code className="font-mono text-xs">{shortModel(v)}</code> },
        {
          title: 'In/Out', dataIndex: 'inputTokens', align: 'right' as const,
          render: (_v: number, r: UsageInference) => <span className="font-mono text-xs" style={{ color: 'var(--color-text-2)' }}>{compact(r.inputTokens)}/{compact(r.outputTokens)}</span>,
        },
        {
          title: 'Cache', dataIndex: 'cacheReadTokens', align: 'right' as const,
          render: (v: number) => v > 0
            ? <span className="font-mono text-xs" style={{ color: 'rgb(var(--green-6))' }}>{compact(v)}</span>
            : <span style={{ color: 'var(--color-text-4)' }}>—</span>,
        },
        {
          title: '耗时', dataIndex: 'latencyMs', align: 'right' as const,
          render: (v: number, r: UsageInference) => (
            <span className="font-mono text-xs" style={{ color: 'var(--color-text-3)' }}>
              {(v / 1000).toFixed(1)}s{r.ttftMs != null ? ` · ttft ${(r.ttftMs / 1000).toFixed(1)}s` : ''}
            </span>
          ),
        },
        { title: '停因', dataIndex: 'stopReason', render: (v: string) => <span className="text-xs" style={{ color: 'var(--color-text-3)' }}>{v}</span> },
        { title: '成本', dataIndex: 'totalCost', align: 'right' as const, render: (v: number) => <Cost v={v} /> },
      ]}
    />
  );
}

// ---- Level 4: one inference, in full ----
function InferenceLevel({ agentId, inferenceId }: { agentId: string; inferenceId: string }) {
  const q = useUsageInferenceDetail(agentId, inferenceId);
  if (q.data === undefined) return <Loading />;
  if (q.data === null) return <Empty description="找不到这条推理(可能已被保留期清理)" />;
  return <InferenceDetailView inf={q.data} />;
}

function InferenceDetailView({ inf }: { inf: UsageInferenceDetail }) {
  // The protocol the wire body was actually serialized in. `provider` is the
  // resolved core provider kind ('anthropic' | 'openai'), set by the family
  // router — the very thing that decides whether cache_control is in play.
  const protocol: WireProtocol = inf.provider === 'anthropic' ? 'anthropic' : 'openai';
  return (
    <div className="flex flex-col gap-4">
      {/* Headline numbers */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Metric label="模型" value={shortModel(inf.model)} mono />
        <Metric label="协议" value={protocol} badge={protocol} />
        <Metric label="成本" value={money(inf.totalCost)} accent />
        <Metric label="In / Out" value={`${compact(inf.inputTokens)} / ${compact(inf.outputTokens)}`} mono />
        <Metric label="Cache 命中" value={inf.cacheReadTokens > 0 ? compact(inf.cacheReadTokens) : '无'} />
        <Metric label="Cache 写入" value={inf.cacheWriteTokens > 0 ? compact(inf.cacheWriteTokens) : '无'} />
        <Metric label="总耗时" value={`${(inf.latencyMs / 1000).toFixed(2)}s`} />
        <Metric label="首字 TTFT" value={inf.ttftMs != null ? `${(inf.ttftMs / 1000).toFixed(2)}s` : '—'} />
      </div>

      <Tabs defaultActiveTab="messages" type="rounded" size="small">
        <Tabs.TabPane key="messages" title={`对话${inf.messageCount ? ` (${inf.messageCount})` : ''}`}>
          <Conversation requestMessages={inf.requestMessages} responseContent={inf.responseContent} />
        </Tabs.TabPane>
        <Tabs.TabPane key="system" title="System Prompt">
          <SystemPrompt raw={inf.requestSystem} />
        </Tabs.TabPane>
        <Tabs.TabPane key="tools" title={`工具列表${inf.toolDefCount ? ` (${inf.toolDefCount})` : ''}`}>
          <ToolDefs raw={inf.requestTools} />
        </Tabs.TabPane>
        <Tabs.TabPane key="toolcalls" title={`Tool Use${inf.toolCalls.length ? ` (${inf.toolCalls.length})` : ''}`}>
          <ToolCalls calls={inf.toolCalls} />
        </Tabs.TabPane>
        <Tabs.TabPane key="wire" title="Provider 原文">
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2 text-xs" style={{ color: 'var(--color-text-3)' }}>
              <span>这是发往供应商的{protocol === 'anthropic' ? ' Anthropic Messages ' : ' OpenAI Chat Completions '}协议原文。</span>
              <ProtocolBadge protocol={protocol} />
            </div>
            <div>
              <div className="text-xs mb-1" style={{ color: 'var(--color-text-3)' }}>Request</div>
              <JsonBlock raw={inf.providerRequest} empty="—" />
            </div>
            <div>
              <div className="text-xs mb-1" style={{ color: 'var(--color-text-3)' }}>Response</div>
              <JsonBlock raw={inf.providerResponse} empty="—" />
            </div>
          </div>
        </Tabs.TabPane>
      </Tabs>
    </div>
  );
}

// The wire protocol a given inference was serialized in. Mirrors the core
// ProviderType; kept local so the UI has no import dependency on @berry-agent/core.
type WireProtocol = 'anthropic' | 'openai';

function ProtocolBadge({ protocol }: { protocol: WireProtocol }) {
  return (
    <Tag size="small" color={protocol === 'anthropic' ? 'arcoblue' : 'gray'}>
      {protocol}
    </Tag>
  );
}

// ---- Canonical content-block rendering ----
// observe stores requestMessages/responseContent as canonical ContentBlock[]
// (protocol-agnostic — adapters translate to/from wire). We render them as a
// readable transcript instead of dumping JSON. Unknown shapes fall back to JSON
// so the view never hides data.

interface AnyBlock {
  type?: string;
  text?: string;
  thinking?: string;
  signature?: string;
  name?: string;
  id?: string;
  input?: unknown;
  toolUseId?: string;
  content?: unknown;
  isError?: boolean;
  mediaType?: string;
}
interface AnyMessage { role?: string; content?: string | AnyBlock[] }

function parseJson<T>(raw: string | null): T | null {
  if (!raw) return null;
  try { return JSON.parse(raw) as T; } catch { return null; }
}

function Conversation({ requestMessages, responseContent }:
  { requestMessages: string | null; responseContent: string | null }) {
  const messages = parseJson<AnyMessage[]>(requestMessages);
  const response = parseJson<AnyBlock[]>(responseContent);
  // If the request body isn't the canonical array shape, fall back to raw JSON
  // (both panes) rather than silently rendering nothing.
  if (!Array.isArray(messages)) {
    return (
      <div className="flex flex-col gap-3">
        <JsonBlock raw={requestMessages} empty="无消息" />
        <div>
          <div className="text-xs mb-1" style={{ color: 'var(--color-text-3)' }}>Output</div>
          <JsonBlock raw={responseContent} empty="无响应内容" />
        </div>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2" style={{ maxHeight: '52vh', overflow: 'auto' }}>
      {messages.map((m, i) => <MessageBubble key={i} role={m.role ?? 'user'} content={m.content} />)}
      {Array.isArray(response) && response.length > 0 && (
        <MessageBubble role="assistant" content={response} label="本次输出" highlight />
      )}
    </div>
  );
}

function MessageBubble({ role, content, label, highlight }:
  { role: string; content: string | AnyBlock[] | undefined; label?: string; highlight?: boolean }) {
  const isUser = role === 'user';
  const blocks: AnyBlock[] = typeof content === 'string'
    ? [{ type: 'text', text: content }]
    : Array.isArray(content) ? content : [];
  return (
    <div className="rounded-md p-2.5"
      style={{
        background: highlight ? 'var(--color-primary-light-1)' : 'var(--color-fill-1)',
        border: highlight ? '1px solid rgb(var(--arcoblue-3))' : '1px solid transparent',
      }}>
      <div className="flex items-center gap-2 mb-1.5">
        <Tag size="small" color={isUser ? 'gray' : 'arcoblue'}>{role}</Tag>
        {label && <span className="text-xs" style={{ color: 'var(--color-text-3)' }}>{label}</span>}
      </div>
      <div className="flex flex-col gap-1.5">
        {blocks.length === 0
          ? <span className="text-xs" style={{ color: 'var(--color-text-4)' }}>(空)</span>
          : blocks.map((b, i) => <Block key={i} b={b} />)}
      </div>
    </div>
  );
}

function Block({ b }: { b: AnyBlock }) {
  switch (b.type) {
    case 'text':
      return <div className="text-sm whitespace-pre-wrap" style={{ color: 'var(--color-text-1)' }}>{b.text}</div>;
    case 'thinking':
      return (
        <div className="rounded p-2" style={{ background: 'var(--color-fill-2)', borderLeft: '2px solid rgb(var(--arcoblue-4))' }}>
          <div className="flex items-center gap-1.5 mb-0.5">
            <span className="text-xs font-medium" style={{ color: 'var(--color-text-3)' }}>thinking</span>
            {b.signature && <Tag size="small" color="green">signed</Tag>}
          </div>
          <div className="text-xs whitespace-pre-wrap" style={{ color: 'var(--color-text-2)' }}>{b.thinking}</div>
        </div>
      );
    case 'tool_use':
      return (
        <div className="rounded p-2" style={{ background: 'var(--color-fill-2)' }}>
          <div className="flex items-center gap-1.5 mb-1">
            <Tag size="small" color="orange">tool_use</Tag>
            <code className="font-mono text-xs font-semibold" style={{ color: 'var(--color-text-1)' }}>{b.name}</code>
          </div>
          <CodeBlock value={pretty(b.input)} />
        </div>
      );
    case 'tool_result':
      return (
        <div className="rounded p-2" style={{ background: 'var(--color-fill-2)' }}>
          <div className="flex items-center gap-1.5 mb-1">
            <Tag size="small" color={b.isError ? 'red' : 'green'}>tool_result{b.isError ? ' · error' : ''}</Tag>
          </div>
          <CodeBlock value={typeof b.content === 'string' ? b.content : pretty(b.content)} />
        </div>
      );
    case 'image':
      return <Tag size="small" color="purple">image · {b.mediaType ?? 'unknown'}</Tag>;
    default:
      return <CodeBlock value={pretty(b)} />;
  }
}

function CodeBlock({ value }: { value: string }) {
  const truncated = value.length > 4000 ? value.slice(0, 4000) + '\n…(截断)' : value;
  return (
    <pre className="overflow-auto p-2 rounded text-xs font-mono whitespace-pre-wrap"
      style={{ maxHeight: '24vh', background: 'var(--color-fill-3)', color: 'var(--color-text-2)' }}>
      {truncated}
    </pre>
  );
}

function pretty(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v, null, 2); } catch { return String(v); }
}

// System prompt is stored as canonical blocks too (text blocks with optional
// cache_control breakpoints). Render the text plainly; fall back to JSON.
function SystemPrompt({ raw }: { raw: string | null }) {
  if (!raw) return <span className="text-xs" style={{ color: 'var(--color-text-4)' }}>无 system prompt</span>;
  const parsed = parseJson<unknown>(raw);
  if (Array.isArray(parsed)) {
    const texts = parsed
      .map((blk) => (blk && typeof blk === 'object' && 'text' in blk ? String((blk as { text: unknown }).text) : null))
      .filter((t): t is string => t != null);
    if (texts.length > 0) {
      return (
        <pre className="overflow-auto p-3 rounded-md text-xs font-mono whitespace-pre-wrap"
          style={{ maxHeight: '46vh', background: 'var(--color-fill-2)', color: 'var(--color-text-1)' }}>
          {texts.join('\n\n———\n\n')}
        </pre>
      );
    }
  }
  return <JsonBlock raw={raw} empty="无 system prompt" />;
}

function Metric({ label, value, accent, mono, badge }:
  { label: string; value: string; accent?: boolean; mono?: boolean; badge?: WireProtocol }) {
  return (
    <div className="rounded-md p-2.5" style={{ background: 'var(--color-fill-1)' }}>
      <div className="text-xs mb-0.5" style={{ color: 'var(--color-text-4)' }}>{label}</div>
      {badge ? (
        <ProtocolBadge protocol={badge} />
      ) : (
        <div className={`text-sm ${mono ? 'font-mono' : 'font-medium'}`}
          style={{ color: accent ? 'rgb(var(--arcoblue-6))' : 'var(--color-text-1)' }}>
          {value}
        </div>
      )}
    </div>
  );
}

// Pretty-print a stored JSON string. observe stores request/response bodies as
// JSON text; we parse + re-indent for reading, falling back to the raw string
// if it isn't valid JSON (never throw in a detail view).
function JsonBlock({ raw, empty }: { raw: string | null; empty: string }) {
  if (!raw) return <span className="text-xs" style={{ color: 'var(--color-text-4)' }}>{empty}</span>;
  let text = raw;
  try { text = JSON.stringify(JSON.parse(raw), null, 2); } catch { /* keep raw */ }
  return (
    <pre className="overflow-auto p-3 rounded-md text-xs font-mono whitespace-pre-wrap"
      style={{ maxHeight: '46vh', background: 'var(--color-fill-2)', color: 'var(--color-text-1)' }}>
      {text}
    </pre>
  );
}

// Tool definitions list — parse the stored JSON array and show name + description
// as compact rows (the full schema is one click away in the raw JSON block).
function ToolDefs({ raw }: { raw: string | null }) {
  if (!raw) return <span className="text-xs" style={{ color: 'var(--color-text-4)' }}>无工具</span>;
  let tools: Array<{ name?: string; description?: string }> = [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) tools = parsed;
  } catch { /* fall through to raw */ }
  if (tools.length === 0) return <JsonBlock raw={raw} empty="无工具" />;
  return (
    <div className="flex flex-col gap-1.5">
      {tools.map((t, i) => (
        <div key={i} className="rounded-md p-2" style={{ background: 'var(--color-fill-1)' }}>
          <code className="font-mono text-xs font-semibold" style={{ color: 'var(--color-text-1)' }}>{t.name ?? '(unnamed)'}</code>
          {t.description && <div className="text-xs mt-0.5" style={{ color: 'var(--color-text-3)' }}>{t.description.slice(0, 160)}{t.description.length > 160 ? '…' : ''}</div>}
        </div>
      ))}
    </div>
  );
}

// The tool calls this inference actually made (with input/output/duration/error).
function ToolCalls({ calls }: { calls: UsageInferenceDetail['toolCalls'] }) {
  if (calls.length === 0) return <span className="text-xs" style={{ color: 'var(--color-text-4)' }}>本次推理没有工具调用</span>;
  return (
    <div className="flex flex-col gap-2">
      {calls.map((c, i) => (
        <div key={i} className="rounded-md p-2.5" style={{ background: 'var(--color-fill-1)' }}>
          <div className="flex items-center justify-between gap-2 mb-1">
            <code className="font-mono text-xs font-semibold" style={{ color: 'var(--color-text-1)' }}>{c.name}</code>
            <span className="flex items-center gap-2">
              {c.isError && <Tag size="small" color="red">error</Tag>}
              <span className="font-mono text-xs" style={{ color: 'var(--color-text-4)' }}>{c.durationMs}ms</span>
            </span>
          </div>
          {c.input && <Mini label="input" raw={c.input} />}
          {c.output && <Mini label="output" raw={c.output} />}
        </div>
      ))}
    </div>
  );
}

function Mini({ label, raw }: { label: string; raw: string }) {
  let text = raw;
  try { text = JSON.stringify(JSON.parse(raw), null, 2); } catch { /* keep */ }
  return (
    <div className="mt-1">
      <div className="text-xs" style={{ color: 'var(--color-text-4)' }}>{label}</div>
      <pre className="overflow-auto p-2 rounded text-xs font-mono whitespace-pre-wrap"
        style={{ maxHeight: '20vh', background: 'var(--color-fill-2)', color: 'var(--color-text-2)' }}>
        {text.length > 2000 ? text.slice(0, 2000) + '\n…(截断)' : text}
      </pre>
    </div>
  );
}

function Mono({ v }: { v: number | string }) {
  return <span className="font-mono text-xs" style={{ color: 'var(--color-text-2)' }}>{v}</span>;
}
function Dim({ v }: { v: string }) {
  return <span className="font-mono text-xs" style={{ color: 'var(--color-text-3)' }}>{v}</span>;
}
function Cost({ v }: { v: number }) {
  return <span className="font-mono text-xs" style={{ color: 'rgb(var(--arcoblue-6))' }}>{money(v)}</span>;
}
