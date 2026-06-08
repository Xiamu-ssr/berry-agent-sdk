import { useEffect, useMemo, useState } from 'react';
import { Card, Button, Input, Tag, Message, Empty } from '@arco-design/web-react';
import {
  useModelsTemplate,
  usePutModelsTemplate,
  useProbeModels,
  type ModelsTemplate,
} from '../api/queries.js';
import { PageHeader, ErrorBanner, Spinner } from '../components/Page.js';

// ============================================================
// Models page — L2 (models) + L3 (tiers)
// ============================================================
// Providers (L1) live on Settings. Here the operator turns a token channel into
// named *models*: pick a provider, pull its catalog (or type an id), and bind it
// under a local model id. Tiers (L3) are quick aliases (`tier:strong`) pointing
// at one of those models. Products/agents only ever pick a model or tier — they
// never see providers. This page edits the `models`/`tiers` slices of the one
// cluster template and round-trips `providers` untouched (Settings owns L1).

interface DraftModel {
  /** Local model id = the value agents request (e.g. `anthropic/claude-opus-4.7`). */
  id: string;
  label?: string;
  family?: 'anthropic' | 'openai';
  /** Provider channels backing this model (first = primary, rest = fallback). */
  providers: Array<{ providerId: string; remoteModelId?: string }>;
}

const TIER_SLOTS = ['strong', 'fast', 'cheap'] as const;

export function ModelsPage() {
  const template = useModelsTemplate();
  const put = usePutModelsTemplate();

  const [models, setModels] = useState<DraftModel[]>([]);
  const [tiers, setTiers] = useState<Record<string, string>>({});
  const [providers, setProviders] = useState<ModelsTemplate['providers']>({});
  const [loadedOnce, setLoadedOnce] = useState(false);

  useEffect(() => {
    if (loadedOnce || !template.data) return;
    const t = template.data.template;
    if (t) {
      setProviders(t.providers ?? {});
      setModels(Object.entries(t.models).map(([id, m]) => ({
        id,
        label: m.label,
        family: m.family,
        providers: m.providers,
      })));
      setTiers(t.tiers ?? {});
    }
    setLoadedOnce(true);
  }, [template.data, loadedOnce]);

  const providerIds = useMemo(() => Object.keys(providers), [providers]);

  const buildTemplate = (): ModelsTemplate => {
    const modelsOut: ModelsTemplate['models'] = {};
    for (const m of models) {
      modelsOut[m.id] = {
        ...(m.label ? { label: m.label } : {}),
        providers: m.providers,
      };
    }
    const tiersOut: Record<string, string> = {};
    for (const [slot, mid] of Object.entries(tiers)) {
      if (mid && modelsOut[mid]) tiersOut[slot] = mid;
    }
    // providers carried verbatim (Settings owns L1).
    return { providers, models: modelsOut, tiers: tiersOut };
  };

  if (template.error) return <ErrorBanner error={template.error} />;
  if (template.isLoading) {
    return (
      <div className="animate-fade-in space-y-6">
        <PageHeader title="Models" subtitle="模型(L2)与快捷档位(L3)" />
        <Card bordered><Spinner /></Card>
      </div>
    );
  }

  const noProviders = providerIds.length === 0;
  const canSave = models.length > 0 && models.every((m) => m.id && m.providers.length > 0);

  return (
    <div className="animate-fade-in space-y-6">
      <PageHeader
        title="Models"
        subtitle="模型(L2)与快捷档位(L3) — 产品和 agent 只需选模型"
      />

      {noProviders ? (
        <Card bordered>
          <div className="text-sm" style={{ color: 'rgb(var(--red-6))' }}>
            还没有供应商。先到 <strong>设置 → 供应商</strong> 加一个 token 渠道,再来创建模型。
          </div>
        </Card>
      ) : (
        <>
          <Card
            bordered
            title={<span className="text-sm font-semibold uppercase tracking-wider">模型 · Models (L2)</span>}
            extra={
              template.data?.updatedAt && (
                <span className="text-xs" style={{ color: 'var(--color-text-4)' }}>
                  updated {new Date(template.data.updatedAt).toLocaleString()}
                </span>
              )
            }
          >
            <p className="text-sm mb-4" style={{ color: 'var(--color-text-3)' }}>
              每个模型绑定一个或多个供应商渠道(第一个为主,其余为容灾)。协议按模型家族自动选定。
            </p>

            <div className="space-y-3">
              {models.length === 0 && (
                <Empty description="还没有模型 — 在下方添加" />
              )}
              {models.map((m, i) => (
                <ModelEditor
                  key={i}
                  model={m}
                  providerIds={providerIds}
                  onChange={(next) => setModels((ms) => ms.map((x, j) => (j === i ? next : x)))}
                  onRemove={() => setModels((ms) => ms.filter((_, j) => j !== i))}
                />
              ))}

              <AddModel
                providers={providers}
                existingIds={new Set(models.map((m) => m.id))}
                onAdd={(m) => setModels((ms) => [...ms, m])}
              />
            </div>
          </Card>

          <Card
            bordered
            title={<span className="text-sm font-semibold uppercase tracking-wider">档位 · Tiers (L3)</span>}
          >
            <p className="text-sm mb-3" style={{ color: 'var(--color-text-3)' }}>
              快捷别名:agent 请求 <code className="text-xs">tier:strong</code> 即解析到指定模型。
            </p>
            {models.length === 0 ? (
              <div className="text-xs" style={{ color: 'var(--color-text-4)' }}>先创建至少一个模型。</div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                {TIER_SLOTS.map((slot) => (
                  <label key={slot} className="text-sm">
                    <span className="block text-xs mb-1" style={{ color: 'var(--color-text-3)' }}>{slot}</span>
                    <select
                      value={tiers[slot] ?? ''}
                      onChange={(e) => setTiers((t) => ({ ...t, [slot]: e.target.value }))}
                      className="w-full rounded-md px-3 py-2 text-sm"
                      style={{ border: '1px solid var(--color-border-2)', background: 'var(--color-bg-2)', color: 'var(--color-text-1)' }}
                    >
                      <option value="">(none)</option>
                      {models.map((m) => <option key={m.id} value={m.id}>{m.id}</option>)}
                    </select>
                  </label>
                ))}
              </div>
            )}
          </Card>

          {put.error && <ErrorBanner error={put.error} />}
          <div className="flex items-center justify-end gap-2">
            {put.isSuccess && <span className="text-xs" style={{ color: 'rgb(var(--green-6))' }}>✓ Saved</span>}
            <Button
              type="primary"
              loading={put.isPending}
              disabled={!canSave}
              onClick={() => put.mutate(buildTemplate(), { onSuccess: () => Message.success('已保存模型') })}
            >
              保存
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

function ModelEditor({
  model,
  providerIds,
  onChange,
  onRemove,
}: {
  model: DraftModel;
  providerIds: string[];
  onChange(next: DraftModel): void;
  onRemove(): void;
}) {
  return (
    <div className="rounded-md p-3 space-y-2" style={{ border: '1px solid var(--color-border-2)' }}>
      <div className="flex items-center justify-between">
        <div className="font-medium text-sm flex items-center gap-2">
          <code className="font-mono text-xs">{model.id}</code>
          {model.family && (
            <Tag size="small" color={model.family === 'anthropic' ? 'arcoblue' : undefined}>{model.family}</Tag>
          )}
        </div>
        <Button type="text" size="mini" status="danger" onClick={onRemove}>Remove</Button>
      </div>

      <div className="space-y-1.5">
        {model.providers.map((ref, i) => (
          <div key={i} className="flex items-center gap-2">
            <span className="text-xs w-12 shrink-0" style={{ color: 'var(--color-text-4)' }}>
              {i === 0 ? '主' : `容灾${i}`}
            </span>
            <select
              value={ref.providerId}
              onChange={(e) => onChange({
                ...model,
                providers: model.providers.map((r, j) => (j === i ? { ...r, providerId: e.target.value } : r)),
              })}
              className="rounded-md px-2 py-1 text-sm"
              style={{ border: '1px solid var(--color-border-2)', background: 'var(--color-bg-2)', color: 'var(--color-text-1)' }}
            >
              {providerIds.map((pid) => <option key={pid} value={pid}>{pid}</option>)}
            </select>
            <Input
              size="small"
              value={ref.remoteModelId ?? ''}
              placeholder="remote model id (留空=同本地 id)"
              onChange={(v) => onChange({
                ...model,
                providers: model.providers.map((r, j) => (j === i ? { ...r, remoteModelId: v.trim() || undefined } : r)),
              })}
            />
            {model.providers.length > 1 && (
              <Button
                type="text"
                size="mini"
                status="danger"
                onClick={() => onChange({ ...model, providers: model.providers.filter((_, j) => j !== i) })}
              >✕</Button>
            )}
          </div>
        ))}
        <Button
          type="text"
          size="mini"
          onClick={() => onChange({ ...model, providers: [...model.providers, { providerId: providerIds[0]! }] })}
        >+ 加容灾渠道</Button>
      </div>
    </div>
  );
}

function AddModel({
  providers,
  existingIds,
  onAdd,
}: {
  providers: ModelsTemplate['providers'];
  existingIds: Set<string>;
  onAdd(m: DraftModel): void;
}) {
  const probe = useProbeModels();
  const providerIds = Object.keys(providers);
  const [providerId, setProviderId] = useState(providerIds[0] ?? '');
  const [available, setAvailable] = useState<string[]>([]);
  const [manual, setManual] = useState('');

  const runProbe = () => {
    const p = providers[providerId];
    if (!p) return;
    probe.mutate(
      { presetId: p.presetId, apiKey: p.apiKey },
      { onSuccess: (r) => setAvailable(r.models) },
    );
  };

  const addModel = (remoteId: string) => {
    const id = remoteId.trim();
    if (!id || existingIds.has(id)) return;
    // Default the local id to the remote id; the operator can rename later by
    // editing the template, but the common case is they match.
    onAdd({ id, providers: [{ providerId }] });
    setManual('');
  };

  const isCached = probe.data?.source === 'known';

  return (
    <div className="rounded-md p-3 space-y-2" style={{ border: '1px dashed var(--color-border-3)' }}>
      <div className="text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--color-text-3)' }}>
        添加模型
      </div>
      <div className="flex items-end gap-2 flex-wrap">
        <label className="text-sm">
          <span className="block text-xs mb-1" style={{ color: 'var(--color-text-3)' }}>供应商</span>
          <select
            value={providerId}
            onChange={(e) => { setProviderId(e.target.value); setAvailable([]); }}
            className="rounded-md px-3 py-2 text-sm"
            style={{ border: '1px solid var(--color-border-2)', background: 'var(--color-bg-2)', color: 'var(--color-text-1)' }}
          >
            {providerIds.map((pid) => <option key={pid} value={pid}>{pid}</option>)}
          </select>
        </label>
        <Button size="small" disabled={!providerId || !providers[providerId]?.apiKey} loading={probe.isPending} onClick={runProbe}>
          拉取模型列表
        </Button>
        {probe.data?.source === 'live' && (
          <span className="text-xs" style={{ color: 'rgb(var(--green-6))' }}>✓ {available.length} live models</span>
        )}
        {isCached && (
          <span className="text-xs" style={{ color: 'rgb(var(--orange-6))' }}>
            ⚠ 拉不到实时列表{probe.data?.warning ? ` (${probe.data.warning})` : ''} — 在下面手填
          </span>
        )}
      </div>
      {probe.error && (
        <div className="text-xs" style={{ color: 'rgb(var(--red-6))' }}>
          {probe.error instanceof Error ? probe.error.message : String(probe.error)}
        </div>
      )}

      <div className="flex items-end gap-2">
        <label className="text-sm flex-1">
          <span className="block text-xs mb-1" style={{ color: 'var(--color-text-3)' }}>手填 model id</span>
          <Input value={manual} placeholder="e.g. anthropic/claude-opus-4.7" onChange={setManual} onPressEnter={() => addModel(manual)} />
        </label>
        <Button disabled={!manual.trim()} onClick={() => addModel(manual)}>添加</Button>
      </div>

      {available.length > 0 && (
        <div className="max-h-44 overflow-auto rounded p-2" style={{ border: '1px solid var(--color-border-2)' }}>
          {available.map((m) => {
            const added = existingIds.has(m);
            return (
              <button
                key={m}
                disabled={added}
                onClick={() => addModel(m)}
                className="flex items-center gap-2 text-sm py-0.5 w-full text-left disabled:opacity-40"
              >
                <span style={{ color: 'rgb(var(--arcoblue-6))' }}>{added ? '✓' : '+'}</span>
                <code className="text-xs">{m}</code>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
