import { useState } from 'react';
import { Card } from '@arco-design/web-react';
import { PageHeader, EmptyState } from '../components/Page.js';
import { EntityPickerField } from '../components/EntityPicker.js';
import { agentPickerConfig } from '../components/entityConfigs.js';
import { DrilldownBody } from './UsageDrilldown.js';

// ============================================================
// 日志 — first-class structured inference log
// ============================================================
// The atom of observability is ONE LLM inference. observe already records every
// inference in full (system prompt / tool list / messages it saw / output /
// tool use / cache / in-out tokens / latency / ttft) and rolls it up to engine
// loop → session → agent. This page makes that the headline view, not a
// drill-down buried behind a token-cost row: pick an agent, then walk
// 会话 → Engine Loop → 推理 → 完整推理详情. Structured logs and token cost sit
// side by side at every rung.
//
// Why agent-scoped: a8s is a stateless proxy; each agent's observe.db lives on
// its owning worker, and the drill endpoints are agent-scoped so a8s can route
// to that worker. Picking the agent first mirrors that boundary.

export function LogsPage() {
  const [agentId, setAgentId] = useState<string | null>(null);

  return (
    <div className="animate-fade-in">
      <PageHeader
        title="日志"
        subtitle="结构化推理日志 · 最小单元是一次 LLM 推理,向上聚合到 Engine Loop / 会话 / Agent"
      />

      <p className="text-sm -mt-3 mb-4 max-w-3xl" style={{ color: 'var(--color-text-3)' }}>
        每一次推理都完整留痕:<strong>System Prompt、工具列表、它看到的消息、它产出的 Output、
        发起的 Tool Use</strong>,连同 cache 命中、in/out token、延迟与首字时间。
        选一个 Agent,沿 会话 → Engine Loop → 推理 逐层下钻到单次推理的全貌。
      </p>

      <Card bordered className="mb-4" bodyStyle={{ padding: 16 }}>
        <div className="flex items-center gap-3">
          <span className="text-xs shrink-0" style={{ color: 'var(--color-text-3)' }}>查看哪个 Agent 的日志</span>
          <div className="flex-1 max-w-md">
            <EntityPickerField
              config={agentPickerConfig}
              value={agentId}
              onChange={setAgentId}
              title="选择要查看日志的 Agent"
              placeholder="点击选择 Agent"
            />
          </div>
        </div>
      </Card>

      {agentId ? (
        <Card bordered bodyStyle={{ padding: 16 }}>
          <DrilldownBody agentId={agentId} />
        </Card>
      ) : (
        <EmptyState icon="🧭" title="先选一个 Agent" hint="选定后即可逐层下钻到每一次推理的结构化日志。" />
      )}
    </div>
  );
}
