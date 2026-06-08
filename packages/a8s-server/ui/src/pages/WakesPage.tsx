import { useState } from 'react';
import { Table, Card, Button, Modal, Input, Popconfirm, Message, DatePicker } from '@arco-design/web-react';
import { useWakes, useCancelWake, useScheduleWake } from '../api/queries.js';
import { PageHeader, ErrorBanner, Spinner, EmptyState } from '../components/Page.js';
import { WakeStatePill, relativeTime } from '../components/StatusPill.js';
import { EntityPickerField } from '../components/EntityPicker.js';
import { agentPickerConfig, sessionPickerConfig } from '../components/entityConfigs.js';

export function WakesPage() {
  const wakes = useWakes();
  const cancel = useCancelWake();
  const [showSchedule, setShowSchedule] = useState(false);

  if (wakes.error) return <ErrorBanner error={wakes.error} />;
  if (!wakes.data) return <Spinner />;

  const columns = [
    { title: 'Wake', dataIndex: 'wakeId', render: (v: string) => <code className="font-mono text-xs">{v.slice(0, 16)}</code> },
    { title: 'Agent', dataIndex: 'agentId', render: (v: string) => <code className="font-mono text-xs">{v}</code> },
    { title: 'Reason', dataIndex: 'reason' },
    { title: 'State', dataIndex: 'state', render: (v: string) => <WakeStatePill state={v} /> },
    { title: 'Due', dataIndex: 'dueAt', render: (v: number) => <span className="text-xs" style={{ color: 'var(--color-text-3)' }}>{relativeTime(v)}</span> },
    {
      title: '',
      dataIndex: '__actions',
      width: 90,
      align: 'right' as const,
      render: (_: unknown, w: { wakeId: string; state: string }) =>
        w.state === 'pending' ? (
          <Popconfirm
            title={`取消 wake ${w.wakeId.slice(0, 12)}…?`}
            okText="取消该 wake"
            cancelText="返回"
            onOk={() => { cancel.mutate(w.wakeId); Message.success('已取消'); }}
          >
            <Button size="mini">取消</Button>
          </Popconfirm>
        ) : null,
    },
  ];

  return (
    <div className="animate-fade-in">
      <PageHeader
        title="Wake queue"
        subtitle={`${wakes.data.length} scheduled · auto-refresh 5s`}
        actions={<Button type="primary" onClick={() => setShowSchedule(true)}>手动排期</Button>}
      />

      {wakes.data.length === 0 ? (
        <EmptyState icon="⏰" title="没有排期的 wake" hint="产品调用 POST /v1/wakes/schedule 时会触发 wake;也可以点「手动排期」。" />
      ) : (
        <Card bordered bodyStyle={{ padding: 0 }}>
          <Table rowKey="wakeId" columns={columns} data={wakes.data} pagination={false} size="small" />
        </Card>
      )}

      {showSchedule && <ScheduleModal onClose={() => setShowSchedule(false)} />}
    </div>
  );
}

function ScheduleModal({ onClose }: { onClose: () => void }) {
  const schedule = useScheduleWake();
  const [agentId, setAgentId] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [dueAt, setDueAt] = useState<number | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const canSubmit = !!agentId && reason.trim() && dueAt != null && !schedule.isPending;

  const submit = async () => {
    if (!canSubmit) return;
    await schedule.mutateAsync({
      agentId: agentId!,
      dueAt: dueAt!,
      reason: reason.trim(),
      sessionId: sessionId ?? undefined,
    });
    Message.success(`已为 ${agentId} 排期 wake`);
    onClose();
  };

  return (
    <Modal
      visible
      title="手动排期 wake"
      onCancel={onClose}
      footer={
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>取消</Button>
          <Button type="primary" loading={schedule.isPending} disabled={!canSubmit} onClick={submit}>排期</Button>
        </div>
      }
    >
      <label className="block mb-3">
        <span className="text-xs" style={{ color: 'var(--color-text-3)' }}>Agent</span>
        <div className="mt-1">
          <EntityPickerField
            config={agentPickerConfig}
            value={agentId}
            onChange={(id) => { setAgentId(id); setSessionId(null); }}
            title="选择要唤醒的 Agent"
            placeholder="点击选择 Agent"
          />
        </div>
      </label>
      <label className="block mb-3">
        <span className="text-xs" style={{ color: 'var(--color-text-3)' }}>触发时间</span>
        <DatePicker
          showTime
          className="mt-1 w-full"
          onChange={(_s, d) => setDueAt(d ? d.valueOf() : null)}
          placeholder="选择日期与时间"
        />
      </label>
      <label className="block mb-3">
        <span className="text-xs" style={{ color: 'var(--color-text-3)' }}>原因</span>
        <Input className="mt-1" value={reason} onChange={setReason} placeholder="为什么唤醒它?" />
      </label>
      <label className="block">
        <span className="text-xs" style={{ color: 'var(--color-text-3)' }}>Session(可选,留空则用活跃 session)</span>
        <div className="mt-1">
          <EntityPickerField
            config={sessionPickerConfig(agentId)}
            value={sessionId}
            onChange={setSessionId}
            title={agentId ? `选择 ${agentId} 的会话` : '请先选择 Agent'}
            placeholder={agentId ? '点击选择会话' : '先选 Agent'}
            clearable
          />
        </div>
      </label>
      {schedule.error ? <div className="text-sm mt-2" style={{ color: 'rgb(var(--red-6))' }}>{schedule.error instanceof Error ? schedule.error.message : String(schedule.error)}</div> : null}
    </Modal>
  );
}
