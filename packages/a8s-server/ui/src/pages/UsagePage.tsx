import { useMemo, useState } from 'react';
import { Card, Input, Table, Tag, Typography } from '@arco-design/web-react';
import { useUsage, type UsageAgentRow, type UsageModelRow, type UsageProductRow } from '../api/queries.js';
import { PageHeader, ErrorBanner, Spinner, EmptyState } from '../components/Page.js';

// ============================================================
// 消耗 — real consumption, aggregated upward from each worker's observe.db
// ============================================================
// Nothing here is invented: every number is the agent-level rollup observe
// already keeps (per-inference tokens + cost → session → agent). a8s fans in
// over the owning workers and sums upward into cluster + per-product totals —
// "向上聚合,不重复记录". inference→loop→session live inside the observe DB;
// this page surfaces the agent rung and above, which is the operator's view.

function money(n: number): string {
  return `$${n.toFixed(n < 1 ? 4 : 2)}`;
}
function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

const EMPTY_AGENTS: UsageAgentRow[] = [];

export function UsagePage() {
  const usage = useUsage();

  // Client-side filter for the per-agent table — operators scanning a large
  // cluster need to jump to one agent or one product without paging. Matches
  // agentId or owner, case-insensitive; sorting by cost is preserved.
  //
  // NOTE: these hooks MUST run on every render, before any early return.
  // Putting them after the loading/error guards changed the hook count
  // between the first (no data → early return) and later renders — React
  // error #310 ("rendered more hooks than during the previous render"),
  // which blanked the whole page once real usage data arrived. Read agents
  // defensively from usage.data so the memo dependency is stable across states.
  const [query, setQuery] = useState('');
  const agents = usage.data?.agents ?? EMPTY_AGENTS;
  const filteredAgents = useMemo(() => {
    const q = query.trim().toLowerCase();
    const sorted = [...agents].sort((a, b) => b.totalCost - a.totalCost);
    if (!q) return sorted;
    return sorted.filter(
      (a) => a.agentId.toLowerCase().includes(q) || (a.owner ?? '').toLowerCase().includes(q),
    );
  }, [agents, query]);

  if (usage.error) return <ErrorBanner error={usage.error} />;
  if (!usage.data) return <Spinner />;

  const { totals, byProduct, byModel } = usage.data;
  const empty = agents.length === 0;

  return (
    <div className="animate-fade-in">
      <PageHeader
        title="消耗"
        subtitle="真实用量 · 每次推理的 token 与成本,自下而上聚合 · auto-refresh 10s"
      />

      <Typography.Paragraph type="secondary" className="-mt-3 mb-5 max-w-3xl text-sm">
        数据源是每台 worker 私有的 <code className="font-mono text-xs mx-0.5">observe.db</code>:一次推理是最小记录单位,
        向上聚到会话、Agent;a8s 再扇入汇总成集群与产品口径——<strong>只向上聚合,不重复记录</strong>。
      </Typography.Paragraph>

      {/* Cluster totals */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        <StatCard label="总成本" value={money(totals.totalCost)} accent />
        <StatCard label="总 Token" value={compact(totals.totalTokens)} />
        <StatCard label="会话数" value={String(totals.sessionCount)} />
        <StatCard label="Agent 数" value={String(totals.agentCount)} />
      </div>

      {empty ? (
        <EmptyState icon="📊" title="还没有消耗数据" hint="等 agent 跑起来并发生推理后,这里会出现真实的 token 与成本。" />
      ) : (
        <>
          {/* Per-product rollup */}
          <section className="mb-6">
            <h2 className="text-sm font-semibold mb-3" style={{ color: 'var(--color-text-2)' }}>按产品</h2>
            <Card bordered bodyStyle={{ padding: 0 }}>
              <Table
                rowKey="product"
                pagination={false}
                size="small"
                data={byProduct}
                expandedRowRender={(row: UsageProductRow) => (
                  <ProductAgents product={row.product} agents={agents} productCost={row.totalCost} />
                )}
                expandProps={{
                  // Drill-down only where it adds something: a product with a
                  // single agent has nothing the 按 Agent table below doesn't
                  // already show, so it gets no chevron.
                  rowExpandable: (row: UsageProductRow) => row.agentCount > 1,
                }}
                columns={[
                  {
                    title: '产品', dataIndex: 'product',
                    render: (v: string) => v === '(unowned)'
                      ? <span style={{ color: 'var(--color-text-4)' }}>未归属</span>
                      : <code className="font-mono text-xs">{v}</code>,
                  },
                  { title: 'Agent', dataIndex: 'agentCount', align: 'right' as const, render: (v: number) => <Num v={v} /> },
                  { title: '会话', dataIndex: 'sessionCount', align: 'right' as const, render: (v: number) => <Num v={v} /> },
                  { title: 'Token', dataIndex: 'totalTokens', align: 'right' as const, render: (v: number) => <Num v={compact(v)} /> },
                  {
                    title: '占比', dataIndex: 'totalCost', align: 'right' as const, width: 132,
                    // Share of cluster cost — pure ratio over the totals we already
                    // show up top, so the operator reads the cost structure at a glance.
                    render: (v: number) => <CostShare value={v} total={totals.totalCost} />,
                  },
                  {
                    title: '成本', dataIndex: 'totalCost', align: 'right' as const,
                    render: (v: number) => <span className="font-mono text-sm" style={{ color: 'rgb(var(--arcoblue-6))' }}>{money(v)}</span>,
                  },
                ]}
              />
            </Card>
          </section>

          {/* Per-model cluster rollup — fan-in over every agent's modelBreakdown.
              Same "向上聚合,不重复记录" rule: each agent owns its per-model
              split; a8s sums it across the cluster. Tells the operator which
              models the spend actually went to, independent of who ran them. */}
          {byModel.length > 0 && (
            <section className="mb-6">
              <h2 className="text-sm font-semibold mb-3" style={{ color: 'var(--color-text-2)' }}>按模型</h2>
              <Card bordered bodyStyle={{ padding: 0 }}>
                <Table
                  rowKey="model"
                  pagination={false}
                  size="small"
                  data={byModel}
                  expandedRowRender={(row: UsageModelRow) => (
                    <ModelAgents model={row.model} agents={agents} modelCost={row.totalCost} />
                  )}
                  expandProps={{
                    // Drill a cluster model row back down to the agents that
                    // actually spent on it. A model run by a single agent adds
                    // nothing the 按 Agent table doesn't already show, so it
                    // gets no chevron — same rule as the per-product drill.
                    rowExpandable: (row: UsageModelRow) => row.agentCount > 1,
                  }}
                  columns={[
                    {
                      title: '模型', dataIndex: 'model',
                      render: (v: string) => <code className="font-mono text-xs">{shortModel(v)}</code>,
                    },
                    { title: 'Agent', dataIndex: 'agentCount', align: 'right' as const, render: (v: number) => <Num v={v} /> },
                    { title: '调用', dataIndex: 'calls', align: 'right' as const, render: (v: number) => <Num v={compact(v)} /> },
                    { title: 'Token', dataIndex: 'totalTokens', align: 'right' as const, render: (v: number) => <Num v={compact(v)} /> },
                    {
                      // Per-call unit cost — totalCost / calls, both already on the
                      // row. Lets the operator compare model price-points directly
                      // (opus 单次比 sonnet 贵几倍) instead of inferring it from
                      // the totals. Pure ratio, no new metric over the wire.
                      title: '均/调用', dataIndex: 'totalCost', align: 'right' as const,
                      render: (_v: number, row: UsageModelRow) => (
                        <span className="font-mono text-xs" style={{ color: 'var(--color-text-3)' }}>
                          {row.calls > 0 ? money(row.totalCost / row.calls) : '—'}
                        </span>
                      ),
                    },
                    {
                      title: '占比', dataIndex: 'totalCost', align: 'right' as const, width: 132,
                      render: (v: number) => <CostShare value={v} total={totals.totalCost} />,
                    },
                    {
                      title: '成本', dataIndex: 'totalCost', align: 'right' as const,
                      render: (v: number) => <span className="font-mono text-sm" style={{ color: 'rgb(var(--arcoblue-6))' }}>{money(v)}</span>,
                    },
                  ]}
                />
              </Card>
            </section>
          )}

          {/* Per-agent detail */}
          <section>
            <div className="flex items-center justify-between mb-3 gap-3">
              <h2 className="text-sm font-semibold" style={{ color: 'var(--color-text-2)' }}>按 Agent</h2>
              <Input.Search
                allowClear
                value={query}
                onChange={setQuery}
                placeholder="按 Agent ID 或产品筛选"
                style={{ width: 240 }}
                size="small"
              />
            </div>
            <Card bordered bodyStyle={{ padding: 0 }}>
              <Table
                rowKey="agentId"
                pagination={{ pageSize: 20, hideOnSinglePage: true, sizeCanChange: false }}
                size="small"
                data={filteredAgents}
                noDataElement={<div className="py-8 text-center text-sm" style={{ color: 'var(--color-text-4)' }}>没有匹配的 Agent</div>}
                expandedRowRender={(row: UsageAgentRow) => <AgentExpanded agent={row} />}
                expandProps={{
                  // Offer the expander when there's anything to drill into — the
                  // tool distribution and/or the per-model cost split. A brand-new
                  // agent with neither gets no chevron.
                  rowExpandable: (row: UsageAgentRow) =>
                    (row.topTools?.length ?? 0) > 0 || (row.modelBreakdown?.length ?? 0) > 0,
                }}
                columns={[
                  { title: 'Agent', dataIndex: 'agentId', render: (v: string) => <code className="font-mono text-xs">{v}</code> },
                  {
                    title: '产品', dataIndex: 'owner',
                    render: (v: string | null) => v
                      ? <Tag size="small">{v}</Tag>
                      : <span style={{ color: 'var(--color-text-4)' }}>—</span>,
                  },
                  { title: '会话', dataIndex: 'sessionCount', align: 'right' as const, render: (v: number) => <Num v={v} /> },
                  { title: 'Token', dataIndex: 'totalTokens', align: 'right' as const, render: (v: number) => <Num v={compact(v)} /> },
                  {
                    title: '模型', dataIndex: 'modelUsage',
                    render: (m: UsageAgentRow['modelUsage']) => {
                      const entries = Object.entries(m ?? {});
                      if (entries.length === 0) return <span style={{ color: 'var(--color-text-4)' }}>—</span>;
                      return (
                        <div className="flex flex-wrap gap-1">
                          {entries.map(([model, count]) => (
                            <Tag key={model} size="small" color="cyan">{shortModel(model)} ×{count}</Tag>
                          ))}
                        </div>
                      );
                    },
                  },
                  {
                    title: '均/会话', dataIndex: 'avgSessionCost', align: 'right' as const,
                    render: (v: number) => <span className="font-mono text-xs" style={{ color: 'var(--color-text-3)' }}>{money(v)}</span>,
                  },
                  {
                    title: '成本', dataIndex: 'totalCost', align: 'right' as const,
                    render: (v: number) => <span className="font-mono text-sm" style={{ color: 'rgb(var(--arcoblue-6))' }}>{money(v)}</span>,
                  },
                ]}
              />
            </Card>
          </section>
        </>
      )}
    </div>
  );
}

function StatCard({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <Card bordered bodyStyle={{ padding: 16 }}>
      <div className="text-xs mb-1" style={{ color: 'var(--color-text-3)' }}>{label}</div>
      <div className="text-2xl font-semibold font-mono"
        style={{ color: accent ? 'rgb(var(--arcoblue-6))' : 'var(--color-text-1)' }}>
        {value}
      </div>
    </Card>
  );
}

function Num({ v }: { v: number | string }) {
  return <span className="font-mono text-sm" style={{ color: 'var(--color-text-2)' }}>{v}</span>;
}

// Drill-down for a product row: the agents that roll up into this product,
// ranked by their share of the product's cost. Pure re-slice of the agents
// array we already have — owner === product (null owner ⇒ "(unowned)"); no
// new metric, just the product→agent structure made navigable.
function ProductAgents({
  product,
  agents,
  productCost,
}: {
  product: string;
  agents: UsageAgentRow[];
  productCost: number;
}) {
  const mine = agents
    .filter((a) => (a.owner ?? '(unowned)') === product)
    .sort((x, y) => y.totalCost - x.totalCost);
  if (mine.length === 0) {
    return <span className="text-xs" style={{ color: 'var(--color-text-4)' }}>没有 Agent 明细</span>;
  }
  return (
    <div className="py-1 pl-1 pr-3">
      <div className="text-xs mb-2" style={{ color: 'var(--color-text-3)' }}>该产品下的 Agent(按成本)</div>
      <div className="flex flex-col gap-1.5 max-w-2xl">
        {mine.map((a) => {
          const pct = productCost > 0 ? (a.totalCost / productCost) * 100 : 0;
          return (
            <div key={a.agentId} className="flex items-center gap-2">
              <code className="font-mono text-xs w-44 shrink-0 truncate" style={{ color: 'var(--color-text-2)' }}>{a.agentId}</code>
              <div className="flex-1 h-2.5 rounded-sm overflow-hidden" style={{ background: 'var(--color-fill-2)' }}>
                <div className="h-full rounded-sm" style={{ width: `${pct}%`, background: 'rgb(var(--arcoblue-5))' }} />
              </div>
              <span className="font-mono text-xs w-12 text-right shrink-0" style={{ color: 'var(--color-text-3)' }}>{money(a.totalCost)}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Drill-down for a model row: the agents that actually spent on this model,
// ranked by their share of the model's cluster cost. Pure re-slice of the
// per-agent modelBreakdown we already carry over the wire — the model rung
// answers "where did the spend go", this answers "who drove it" without
// inventing any new metric (向上聚合,不重复记录,只是把同一份数据按模型重切).
function ModelAgents({
  model,
  agents,
  modelCost,
}: {
  model: string;
  agents: UsageAgentRow[];
  modelCost: number;
}) {
  const mine = agents
    .map((a) => {
      const stat = (a.modelBreakdown ?? []).find((m) => m.model === model);
      return stat ? { agentId: a.agentId, cost: stat.totalCost, calls: stat.calls } : null;
    })
    .filter((x): x is { agentId: string; cost: number; calls: number } => x !== null)
    .sort((x, y) => y.cost - x.cost);
  if (mine.length === 0) {
    return <span className="text-xs" style={{ color: 'var(--color-text-4)' }}>没有 Agent 明细</span>;
  }
  return (
    <div className="py-1 pl-1 pr-3">
      <div className="text-xs mb-2" style={{ color: 'var(--color-text-3)' }}>用该模型的 Agent(按成本)</div>
      <div className="flex flex-col gap-1.5 max-w-2xl">
        {mine.map((a) => {
          const pct = modelCost > 0 ? (a.cost / modelCost) * 100 : 0;
          return (
            <div key={a.agentId} className="flex items-center gap-2">
              <code className="font-mono text-xs w-44 shrink-0 truncate" style={{ color: 'var(--color-text-2)' }}>{a.agentId}</code>
              <div className="flex-1 h-2.5 rounded-sm overflow-hidden" style={{ background: 'var(--color-fill-2)' }}>
                <div className="h-full rounded-sm" style={{ width: `${pct}%`, background: 'rgb(var(--arcoblue-5))' }} />
              </div>
              <span className="font-mono text-xs w-10 text-right shrink-0" style={{ color: 'var(--color-text-4)' }}>{compact(a.calls)}</span>
              {/* Per-call unit cost for this agent on this model — same model run
                  by two agents can still differ in $/call (longer context, more
                  retries). cost/calls, both already on the slice. */}
              <span className="font-mono text-xs w-14 text-right shrink-0" style={{ color: 'var(--color-text-4)' }}>{a.calls > 0 ? `${money(a.cost / a.calls)}/次` : '—'}</span>
              <span className="font-mono text-xs w-12 text-right shrink-0" style={{ color: 'var(--color-text-3)' }}>{money(a.cost)}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Expanded-row content for the per-agent table, combining two pure re-slices
// of data this agent already carries: its per-model cost split (the model rung
// seen from one agent — symmetric with the 按模型 drill that goes the other
// way) and its tool-call distribution. No new metric; both come straight off
// the agent row. Rendered side by side so an operator reads "what models did
// this agent spend on" next to "where did its work go".
function AgentExpanded({ agent }: { agent: UsageAgentRow }) {
  const models = [...(agent.modelBreakdown ?? [])].sort((a, b) => b.totalCost - a.totalCost);
  const hasModels = models.length > 0;
  const hasTools = (agent.topTools?.length ?? 0) > 0;
  return (
    <div className="flex flex-col lg:flex-row gap-6 py-1 pl-1 pr-3">
      {hasModels && (
        <div className="flex-1 min-w-0">
          <div className="text-xs mb-2" style={{ color: 'var(--color-text-3)' }}>该 Agent 的模型成本(按成本)</div>
          <div className="flex flex-col gap-1.5 max-w-md">
            {models.map((m) => {
              const pct = agent.totalCost > 0 ? (m.totalCost / agent.totalCost) * 100 : 0;
              return (
                <div key={m.model} className="flex items-center gap-2">
                  <code className="font-mono text-xs w-40 shrink-0 truncate" style={{ color: 'var(--color-text-2)' }}>{shortModel(m.model)}</code>
                  <div className="flex-1 h-2.5 rounded-sm overflow-hidden" style={{ background: 'var(--color-fill-2)' }}>
                    <div className="h-full rounded-sm" style={{ width: `${pct}%`, background: 'rgb(var(--arcoblue-5))' }} />
                  </div>
                  <span className="font-mono text-xs w-10 text-right shrink-0" style={{ color: 'var(--color-text-4)' }}>{compact(m.calls)}</span>
                  {/* Per-call unit cost on this model — cost/calls, both on the
                      breakdown. Symmetric with the 按模型 rung's 均/调用 column. */}
                  <span className="font-mono text-xs w-14 text-right shrink-0" style={{ color: 'var(--color-text-4)' }}>{m.calls > 0 ? `${money(m.totalCost / m.calls)}/次` : '—'}</span>
                  <span className="font-mono text-xs w-12 text-right shrink-0" style={{ color: 'var(--color-text-3)' }}>{money(m.totalCost)}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}
      {hasTools && (
        <div className="flex-1 min-w-0">
          <ToolBreakdown tools={agent.topTools} />
        </div>
      )}
    </div>
  );
}

// Expanded-row content for the per-agent table: the tool-call distribution
// observe already keeps (top tools by invocation count). Pure surfacing of
// existing data — a horizontal bar gives the operator an at-a-glance "where
// did this agent's work actually go" read without inventing any metric.
function ToolBreakdown({ tools }: { tools: UsageAgentRow['topTools'] }) {
  const rows = tools ?? [];
  if (rows.length === 0) {
    return <span className="text-xs" style={{ color: 'var(--color-text-4)' }}>没有工具调用记录</span>;
  }
  const max = Math.max(...rows.map((t) => t.count), 1);
  return (
    <div className="py-1 pl-1 pr-3">
      <div className="text-xs mb-2" style={{ color: 'var(--color-text-3)' }}>工具调用分布(按次数)</div>
      <div className="flex flex-col gap-1.5 max-w-xl">
        {rows.map((t) => (
          <div key={t.name} className="flex items-center gap-2">
            <code className="font-mono text-xs w-32 shrink-0 truncate" style={{ color: 'var(--color-text-2)' }}>{t.name}</code>
            <div className="flex-1 h-2.5 rounded-sm overflow-hidden" style={{ background: 'var(--color-fill-2)' }}>
              <div
                className="h-full rounded-sm"
                style={{ width: `${(t.count / max) * 100}%`, background: 'rgb(var(--arcoblue-5))' }}
              />
            </div>
            <span className="font-mono text-xs w-10 text-right shrink-0" style={{ color: 'var(--color-text-3)' }}>{t.count}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// A compact "share of cluster cost" cell: a thin bar + percentage. Reads the
// per-product cost against the cluster total we already surface in the header
// stat cards — no new metric, just structure made visible inline in the table.
function CostShare({ value, total }: { value: number; total: number }) {
  const pct = total > 0 ? (value / total) * 100 : 0;
  return (
    <div className="flex items-center justify-end gap-2">
      <div className="w-14 h-1.5 rounded-sm overflow-hidden shrink-0" style={{ background: 'var(--color-fill-2)' }}>
        <div className="h-full rounded-sm" style={{ width: `${pct}%`, background: 'rgb(var(--arcoblue-5))' }} />
      </div>
      <span className="font-mono text-xs w-10 text-right" style={{ color: 'var(--color-text-3)' }}>
        {pct >= 10 ? pct.toFixed(0) : pct.toFixed(1)}%
      </span>
    </div>
  );
}

// Trim the provider prefix + date suffix for a compact model chip.
function shortModel(model: string): string {
  return model.replace(/^.*\//, '').replace(/-\d{8}$/, '');
}
