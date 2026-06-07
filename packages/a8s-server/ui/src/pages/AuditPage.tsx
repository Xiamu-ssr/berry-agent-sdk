import { useState } from 'react';
import { Table, Card, Select, Input, Tag, Button } from '@arco-design/web-react';
import { useAudit, type AuditEntry } from '../api/queries.js';
import { PageHeader, ErrorBanner, Spinner, EmptyState } from '../components/Page.js';
import { relativeTime } from '../components/StatusPill.js';

// ============================================================
// Audit log — operator actions (who did what, when, outcome)
// ============================================================
// Reads the append-only audit log via GET /v1/operator/audit. Filterable by
// action verb and outcome; defaults to the last 7 days, newest first.

export function AuditPage() {
  const [action, setAction] = useState('');
  const [outcome, setOutcome] = useState<'ok' | 'err' | ''>('');
  const audit = useAudit({ action: action || undefined, outcome: outcome || undefined, limit: 500 });

  const columns = [
    {
      title: '时间',
      dataIndex: 'ts',
      width: 130,
      render: (v: number) => <span className="text-xs" style={{ color: 'var(--color-text-3)' }} title={new Date(v).toLocaleString()}>{relativeTime(v)}</span>,
    },
    { title: '动作', dataIndex: 'action', render: (v: string) => <code className="font-mono text-xs">{v}</code> },
    {
      title: '主体',
      dataIndex: 'actor',
      render: (v: string) => <span className="text-xs" style={{ color: 'var(--color-text-2)' }}>{v}</span>,
    },
    {
      title: '目标',
      dataIndex: 'target',
      render: (v: string | undefined) => v ? <code className="font-mono text-xs">{v}</code> : <span style={{ color: 'var(--color-text-4)' }}>—</span>,
    },
    {
      title: '结果',
      dataIndex: 'outcome',
      width: 80,
      render: (v: 'ok' | 'err') => <Tag size="small" color={v === 'ok' ? 'green' : 'red'}>{v}</Tag>,
    },
    {
      title: '详情',
      dataIndex: 'details',
      render: (v: Record<string, unknown> | undefined) =>
        v && Object.keys(v).length > 0
          ? <code className="font-mono text-[11px]" style={{ color: 'var(--color-text-3)' }}>{JSON.stringify(v)}</code>
          : <span style={{ color: 'var(--color-text-4)' }}>—</span>,
    },
  ];

  return (
    <div className="animate-fade-in">
      <PageHeader
        title="Audit log"
        subtitle="运营者操作记录 — 谁、何时、做了什么、结果如何"
        actions={
          <div className="flex items-center gap-2">
            <Input
              allowClear
              value={action}
              onChange={setAction}
              placeholder="按动作过滤,如 worker.drain"
              style={{ width: 200 }}
            />
            <Select value={outcome} onChange={setOutcome} style={{ width: 120 }} placeholder="结果">
              <Select.Option value="">全部结果</Select.Option>
              <Select.Option value="ok">ok</Select.Option>
              <Select.Option value="err">err</Select.Option>
            </Select>
            <Button onClick={() => audit.refetch()} loading={audit.isFetching}>刷新</Button>
          </div>
        }
      />

      <p className="text-sm -mt-3 mb-4 max-w-3xl" style={{ color: 'var(--color-text-3)' }}>
        每个改变集群状态的操作(worker drain/evict、agent 创建/删除、wake 排期/取消、join 脚本发放、凭证发放/吊销等)
        都会落一行 append-only 日志。默认展示最近 7 天,最新在前。
      </p>

      {audit.error ? (
        <ErrorBanner error={audit.error} />
      ) : !audit.data ? (
        <Spinner />
      ) : audit.data.entries.length === 0 ? (
        <EmptyState icon="📋" title="没有匹配的审计记录" hint="改变集群状态的操作会出现在这里。调整过滤条件试试。" />
      ) : (
        <Card bordered bodyStyle={{ padding: 0 }}>
          <Table
            rowKey={(r: AuditEntry) => `${r.ts}-${r.action}-${r.target ?? ''}`}
            columns={columns}
            data={audit.data.entries}
            pagination={{ pageSize: 20, sizeCanChange: false }}
            size="small"
          />
          {audit.data.truncated && (
            <div className="px-3 py-2 text-xs" style={{ color: 'var(--color-text-3)', borderTop: '1px solid var(--color-border-2)' }}>
              结果已截断(命中上限)。缩小时间范围或加过滤条件以看到更早的记录。
            </div>
          )}
        </Card>
      )}
    </div>
  );
}
