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

/** The drill-down modal, opened from a per-agent row on the 消耗 page. */
export function UsageDrilldown({ agentId, onClose }: { agentId: string; onClose: () => void }) {
  const [stack, setStack] = useState<Level[]>([{ kind: 'sessions' }]);
  const level = stack[stack.length - 1];
  const push = (l: Level) => setStack((s) => [...s, l]);
  const popTo = (i: number) => setStack((s) => s.slice(0, i + 1));

  return (
    <Modal
      visible
      title={<span>消耗钻取 · <code className="font-mono text-sm">{agentId}</code></span>}
      onCancel={onClose}
      footer={null}
      style={{ width: 960, top: 40 }}
    >
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
  return (
    <div className="flex flex-col gap-4">
      {/* Headline numbers */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Metric label="模型" value={shortModel(inf.model)} mono />
        <Metric label="成本" value={money(inf.totalCost)} accent />
        <Metric label="In / Out" value={`${compact(inf.inputTokens)} / ${compact(inf.outputTokens)}`} mono />
        <Metric label="Cache 命中" value={inf.cacheReadTokens > 0 ? compact(inf.cacheReadTokens) : '无'} />
        <Metric label="Cache 写入" value={inf.cacheWriteTokens > 0 ? compact(inf.cacheWriteTokens) : '无'} />
        <Metric label="总耗时" value={`${(inf.latencyMs / 1000).toFixed(2)}s`} />
        <Metric label="首字 TTFT" value={inf.ttftMs != null ? `${(inf.ttftMs / 1000).toFixed(2)}s` : '—'} />
        <Metric label="停止原因" value={inf.stopReason} />
      </div>

      <Tabs defaultActiveTab="system" type="rounded" size="small">
        <Tabs.TabPane key="system" title="System Prompt">
          <JsonBlock raw={inf.requestSystem} empty="无 system prompt" />
        </Tabs.TabPane>
        <Tabs.TabPane key="tools" title={`工具列表${inf.toolDefCount ? ` (${inf.toolDefCount})` : ''}`}>
          <ToolDefs raw={inf.requestTools} />
        </Tabs.TabPane>
        <Tabs.TabPane key="messages" title={`消息${inf.messageCount ? ` (${inf.messageCount})` : ''}`}>
          <JsonBlock raw={inf.requestMessages} empty="无消息" />
        </Tabs.TabPane>
        <Tabs.TabPane key="response" title="Output">
          <JsonBlock raw={inf.responseContent} empty="无响应内容" />
        </Tabs.TabPane>
        <Tabs.TabPane key="toolcalls" title={`Tool Use${inf.toolCalls.length ? ` (${inf.toolCalls.length})` : ''}`}>
          <ToolCalls calls={inf.toolCalls} />
        </Tabs.TabPane>
        <Tabs.TabPane key="wire" title="Provider 原文">
          <div className="flex flex-col gap-3">
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

function Metric({ label, value, accent, mono }: { label: string; value: string; accent?: boolean; mono?: boolean }) {
  return (
    <div className="rounded-md p-2.5" style={{ background: 'var(--color-fill-1)' }}>
      <div className="text-xs mb-0.5" style={{ color: 'var(--color-text-4)' }}>{label}</div>
      <div className={`text-sm ${mono ? 'font-mono' : 'font-medium'}`}
        style={{ color: accent ? 'rgb(var(--arcoblue-6))' : 'var(--color-text-1)' }}>
        {value}
      </div>
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
