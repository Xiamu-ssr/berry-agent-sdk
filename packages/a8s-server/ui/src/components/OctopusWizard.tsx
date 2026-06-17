import { useState, useMemo } from 'react';
import { Modal, Button, Input, Tag, Checkbox, Steps, Form, Message } from '@arco-design/web-react';
import {
  useModelsTemplate, useWorkers, useMachines, useHandRecipes,
  useCreateAgent, useEnsureAdminAgent,
  type HandRecipe,
} from '../api/queries.js';
import { EntityPickerField } from './EntityPicker.js';
import { modelPickerConfig } from './entityConfigs.js';
import { OctopusPreview } from './OctopusView.js';
import { PageHeader, ErrorBanner, Spinner } from './Page.js';

// ============================================================
// OctopusWizard — 4-step agent creation with octopus preview
// ============================================================
// Step 0: 身份 (Agent ID + Worker)
// Step 1: 大脑 (Model + Classifier)
// Step 2: 触手 (Hand selection)
// Step 3: 确认 (Octopus preview + submit)

export interface OctopusWizardProps {
  existingIds?: Set<string>;
  adminMode?: boolean;
  onClose: () => void;
  onCreated?: () => void;
}

export function OctopusWizard({ existingIds, adminMode, onClose, onCreated }: OctopusWizardProps) {
  const template = useModelsTemplate();
  const workers = useWorkers();
  const machines = useMachines();
  const recipes = useHandRecipes();
  const createAgent = useCreateAgent();
  const ensureAdmin = useEnsureAdminAgent();

  const [step, setStep] = useState(0);

  // Step 0: Identity
  const [agentId, setAgentId] = useState(adminMode ? 'berry-admin' : '');

  // Step 1: Brain
  const [model, setModel] = useState('');
  const [classifierModel, setClassifierModel] = useState<string | null>(null);

  // Step 2: Hands
  const [selectedHandIds, setSelectedHandIds] = useState<string[]>([]);

  const activeWorkers = (workers.data ?? []).filter((w) => w.state === 'active');
  const activeMachines = (machines.data ?? []).filter((m) => m.state === 'active');
  const localMachines = activeMachines.filter((m) => {
    try { const h = new URL(m.callbackUrl).hostname; return h === '127.0.0.1' || h === 'localhost'; }
    catch { return false; }
  });
  const allHands = recipes.data ?? [];

  const templateReady = useMemo(
    () => !!template.data?.template && Object.keys(template.data.template.models ?? {}).length > 0,
    [template.data],
  );

  // Derived
  const idValid = /^[a-zA-Z0-9._-]{1,64}$/.test(agentId);
  const idCollides = existingIds?.has(agentId) ?? false;
  const selectedHands = allHands.filter((r) => selectedHandIds.includes(r.id));
  const effectiveMachines = Array.from(new Set(selectedHands.map((h) => h.machineId)));

  // Admin mode constraints
  const adminLocalHands = allHands.filter((h) => localMachines.some((m) => m.machineId === h.machineId));

  const canNext = (): boolean => {
    switch (step) {
      case 0: return idValid && !idCollides;
      case 1: return model.length > 0;
      case 2: return selectedHandIds.length > 0;
      case 3: return true;
      default: return false;
    }
  };

  const next = () => setStep((s) => Math.min(s + 1, 3));
  const prev = () => setStep((s) => Math.max(s - 1, 0));

  const submit = () => {
    if (adminMode) {
      ensureAdmin.mutate(
        {
          ...(model ? { model } : {}),
          ...(classifierModel ? { classifierModel } : {}),
          ...(effectiveMachines.length > 0 ? { machines: effectiveMachines.join(',') } : {}),
        },
        {
          onSuccess: () => {
            Message.success('berry-admin 已创建');
            onCreated?.();
            onClose();
          },
        },
      );
    } else {
      createAgent.mutate(
        {
          agentId: agentId.trim(),
          model: model.trim(),
          ...(classifierModel ? { classifierModel } : {}),
          labels: effectiveMachines.length > 0 ? { machines: effectiveMachines.join(',') } : undefined,
        },
        {
          onSuccess: () => {
            Message.success(`已创建 ${agentId.trim()}`);
            onCreated?.();
            onClose();
          },
        },
      );
    }
  };

  const isPending = adminMode ? ensureAdmin.isPending : createAgent.isPending;
  const error = adminMode ? ensureAdmin.error : createAgent.error;

  if (template.isLoading || workers.isLoading) {
    return (
      <Modal visible title={adminMode ? '初始化 Admin Agent' : '创建 Agent'} onCancel={onClose} style={{ width: 720 }} footer={null}>
        <Spinner />
      </Modal>
    );
  }

  return (
    <Modal
      visible
      title={adminMode ? '初始化 Admin Agent' : '创建 Agent'}
      onCancel={onClose}
      style={{ width: 900 }}
      footer={
        <div className="flex justify-between items-center">
          <span className="text-xs" style={{ color: 'var(--color-text-3)' }}>
            {agentId ? agentId : '—'}
            {model ? ` · ${shortModel(model)}` : ''}
            {selectedHandIds.length > 0 ? ` · ${selectedHandIds.length} Hand` : ''}
          </span>
          <div className="flex gap-2">
            {step > 0 && <Button onClick={prev}>上一步</Button>}
            {step < 3 && <Button type="primary" disabled={!canNext()} onClick={next}>下一步</Button>}
            {step === 3 && <Button type="primary" loading={isPending} onClick={submit}>创建</Button>}
          </div>
        </div>
      }
    >
      <Steps current={step} size="small" className="mb-5">
        <Steps.Step title="身份" description="命名" />
        <Steps.Step title="大脑" description="选模型" />
        <Steps.Step title="触手" description="配 Hand" />
        <Steps.Step title="确认" description="完成" />
      </Steps>

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_280px] gap-4">
        <div className="min-w-0">
          {step === 0 && (
            <StepIdentity
              agentId={agentId}
              setAgentId={setAgentId}
              idValid={idValid}
              idCollides={idCollides}
              locked={!!adminMode}
              workerCount={activeWorkers.length}
            />
          )}
          {step === 1 && (
            <StepBrain
              model={model}
              setModel={setModel}
              classifierModel={classifierModel}
              setClassifierModel={setClassifierModel}
              templateReady={templateReady}
            />
          )}
          {step === 2 && (
            <StepHands
              allHands={adminMode ? adminLocalHands : allHands}
              activeMachines={adminMode ? localMachines : activeMachines}
              selectedIds={selectedHandIds}
              setSelectedIds={setSelectedHandIds}
              adminMode={!!adminMode}
            />
          )}
          {step === 3 && (
            <StepConfirm
              agentId={agentId}
              model={model}
              classifierModel={classifierModel}
              selectedHands={selectedHands}
            />
          )}
          {error && <div className="mt-3"><ErrorBanner error={error} /></div>}
        </div>

        {/* Live octopus preview — grows as user adds brain/hands */}
        <div className="hidden lg:flex flex-col items-center justify-center">
          <OctopusPreview
            model={model || 'tier:strong'}
            hands={selectedHands}
          />
        </div>
      </div>
    </Modal>
  );
}

// ============================================================
// Step components
// ============================================================

function StepIdentity({ agentId, setAgentId, idValid, idCollides, locked, workerCount }: {
  agentId: string; setAgentId: (v: string) => void;
  idValid: boolean; idCollides: boolean; locked: boolean; workerCount: number;
}) {
  return (
    <div className="space-y-4">
      <Form layout="vertical">
        <Form.Item
          label="Agent ID"
          extra={locked ? 'Admin agent 使用固定 ID。' : '字母、数字、点、横线、下划线,最多 64 字符。'}
          validateStatus={agentId.length > 0 && (!idValid || idCollides) ? 'error' : undefined}
          help={!idValid && agentId.length > 0 ? '格式不合法' : idCollides ? '已存在同名' : undefined}
        >
          <Input
            value={agentId}
            onChange={setAgentId}
            placeholder="e.g. my-agent"
            disabled={locked}
            autoFocus={!locked}
          />
        </Form.Item>
      </Form>
      <div className="text-xs" style={{ color: 'var(--color-text-3)' }}>
        当前有 <strong>{workerCount}</strong> 个活跃 Worker,agent 将被调度到可用 Worker 上运行。
      </div>
    </div>
  );
}

function StepBrain({ model, setModel, classifierModel, setClassifierModel, templateReady }: {
  model: string; setModel: (v: string) => void;
  classifierModel: string | null; setClassifierModel: (v: string | null) => void;
  templateReady: boolean;
}) {
  return (
    <div className="space-y-4">
      {!templateReady && (
        <div className="text-xs p-2 rounded" style={{ color: 'rgb(var(--red-6))', background: 'rgb(var(--red-1))' }}>
          先在 Models 页配置至少一个模型。
        </div>
      )}
      <Form layout="vertical">
        <Form.Item label="主模型" extra="agent 推理时使用的 LLM。">
          <EntityPickerField
            config={modelPickerConfig}
            value={model || null}
            onChange={(v) => setModel(v ?? '')}
            title="选择模型"
            placeholder="点击选择模型 / 档位…"
          />
        </Form.Item>
        <Form.Item label="审批模型" extra="安全分类器模型。留空 = SDK 默认。">
          <EntityPickerField
            config={modelPickerConfig}
            value={classifierModel}
            onChange={setClassifierModel}
            title="选择审批模型"
            placeholder="留空用默认…"
            clearable
          />
        </Form.Item>
      </Form>
    </div>
  );
}

function StepHands({ allHands, activeMachines, selectedIds, setSelectedIds, adminMode }: {
  allHands: HandRecipe[];
  activeMachines: Array<{ machineId: string; platform?: string }>;
  selectedIds: string[];
  setSelectedIds: (ids: string[]) => void;
  adminMode: boolean;
}) {
  const toggle = (id: string) => {
    setSelectedIds(
      selectedIds.includes(id) ? selectedIds.filter((x) => x !== id) : [...selectedIds, id],
    );
  };

  return (
    <div className="space-y-4">
      <div className="text-sm" style={{ color: 'var(--color-text-2)' }}>
        {adminMode
          ? '选择本机 Hand(至少一个)。Admin agent 通过 Hand 获得对 a8s 所在机器的操作能力。'
          : '勾选要授权给 agent 的 Hand。每个 Hand 提供一台机器的执行能力(shell + MCP)。'}
      </div>

      {allHands.length === 0 ? (
        <div className="p-4 rounded text-center" style={{ background: 'var(--color-fill-2)' }}>
          <div className="text-sm mb-2" style={{ color: 'var(--color-text-3)' }}>
            {adminMode ? '本机还没有 Hand。' : '还没有 Hand。'}
          </div>
          <div className="text-xs" style={{ color: 'var(--color-text-4)' }}>
            去「Hand 市场」创建一个,或直接选择下方的机器(自动创建默认 Hand)。
          </div>
          {/* Fallback: direct machine selection */}
          {activeMachines.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-2 justify-center">
              {activeMachines.map((m) => {
                const fakeId = `__machine__${m.machineId}`;
                const on = selectedIds.includes(fakeId);
                return (
                  <Checkbox key={fakeId} checked={on} onChange={() => toggle(fakeId)}>
                    <code className="font-mono text-xs">{m.machineId}</code>
                    <span className="text-xs ml-1" style={{ color: 'var(--color-text-3)' }}>({m.platform ?? '?'})</span>
                  </Checkbox>
                );
              })}
            </div>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {allHands.map((h) => {
            const on = selectedIds.includes(h.id);
            return (
              <div
                key={h.id}
                className="p-3 rounded-lg cursor-pointer transition-all"
                style={{
                  border: `2px solid ${on ? 'rgb(var(--arcoblue-6))' : 'var(--color-border-2)'}`,
                  background: on ? 'rgb(var(--arcoblue-1))' : 'var(--color-bg-2)',
                }}
                onClick={() => toggle(h.id)}
              >
                <div className="flex items-center justify-between mb-1">
                  <span className="text-sm font-medium" style={{ color: 'var(--color-text-1)' }}>{h.name}</span>
                  {on && <Tag size="small" color="arcoblue">已选</Tag>}
                </div>
                <div className="text-xs" style={{ color: 'var(--color-text-3)' }}>
                  <code className="font-mono">{h.machineId}</code>
                  {h.toolGroups.length > 0 && ` · ${h.toolGroups.join(', ')}`}
                  {h.mcpServerRefs.length > 0 && ` · ${h.mcpServerRefs.length} MCP`}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function StepConfirm({ agentId, model, classifierModel, selectedHands }: {
  agentId: string; model: string; classifierModel: string | null; selectedHands: HandRecipe[];
}) {
  return (
    <div className="space-y-4">
      <div className="text-sm font-semibold" style={{ color: 'var(--color-text-1)' }}>预览</div>

      <div className="flex justify-center">
        <OctopusPreview model={model || 'tier:strong'} hands={selectedHands} />
      </div>

      <div className="p-3 rounded text-xs space-y-1" style={{ background: 'var(--color-fill-2)' }}>
        <div><strong>Agent ID:</strong> <code className="font-mono">{agentId}</code></div>
        <div><strong>模型:</strong> <code className="font-mono">{model || 'tier:strong'}</code></div>
        {classifierModel && <div><strong>审批:</strong> <code className="font-mono">{classifierModel}</code></div>}
        <div><strong>Hand ({selectedHands.length}):</strong> {selectedHands.map((h) => h.name).join(', ') || '(无)'}</div>
        <div><strong>Machine:</strong> {Array.from(new Set(selectedHands.map((h) => h.machineId))).join(', ') || '(无)'}</div>
      </div>
    </div>
  );
}

function shortModel(model: string): string {
  const parts = model.split('/');
  const name = parts[parts.length - 1];
  if (name.length > 20) return name.slice(0, 18) + '…';
  return name;
}
