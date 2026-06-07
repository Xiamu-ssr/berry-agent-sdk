import { Card, Table, Tag, Typography } from '@arco-design/web-react';
import { useUsage, type UsageAgentRow } from '../api/queries.js';
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

export function UsagePage() {
  const usage = useUsage();

  if (usage.error) return <ErrorBanner error={usage.error} />;
  if (!usage.data) return <Spinner />;

  const { totals, byProduct, agents } = usage.data;
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
                    title: '成本', dataIndex: 'totalCost', align: 'right' as const,
                    render: (v: number) => <span className="font-mono text-sm" style={{ color: 'rgb(var(--arcoblue-6))' }}>{money(v)}</span>,
                  },
                ]}
              />
            </Card>
          </section>

          {/* Per-agent detail */}
          <section>
            <h2 className="text-sm font-semibold mb-3" style={{ color: 'var(--color-text-2)' }}>按 Agent</h2>
            <Card bordered bodyStyle={{ padding: 0 }}>
              <Table
                rowKey="agentId"
                pagination={{ pageSize: 20, hideOnSinglePage: true, sizeCanChange: false }}
                size="small"
                data={[...agents].sort((a, b) => b.totalCost - a.totalCost)}
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

// Trim the provider prefix + date suffix for a compact model chip.
function shortModel(model: string): string {
  return model.replace(/^.*\//, '').replace(/-\d{8}$/, '');
}
