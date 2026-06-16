import { useEffect, useState } from 'react';
import { Card, Button, Input, Tag, Message } from '@arco-design/web-react';
import {
  useModelsTemplate,
  usePutModelsTemplate,
  useModelsPresets,
  type ModelsTemplate,
  type ModelsPreset,
  type ProviderEndpoints,
} from '../api/queries.js';
import { PageHeader, ErrorBanner, Spinner } from '../components/Page.js';

export function SettingsPage() {
  return (
    <div className="animate-fade-in space-y-6">
      <PageHeader
        title="设置"
        subtitle="供应商配置 — 集群级"
      />
      <ProvidersCard />
    </div>
  );
}

// ============================================================
// Providers (L1) — token channels
// ============================================================
// L1 is just "where the tokens come from": a preset (or raw) + an API key, and
// optionally an endpoint override. It does NOT define models — that's L2, on the
// Models page. A provider may speak both protocols (e.g. ZenMux at two URLs);
// the resolver picks the endpoint per model family, so the operator never picks
// a protocol here. Both pages edit slices of one cluster template; this card
// owns `providers` and round-trips `models`/`tiers` untouched.

interface DraftProvider {
  /** Local key in the template's providers map. */
  id: string;
  presetId: string;
  apiKey: string;
  /** Per-protocol endpoint overrides (raw providers must set at least one). */
  endpoints?: ProviderEndpoints;
  label?: string;
}

const RAW_PRESET_ID = '__raw__';

function ProvidersCard() {
  const template = useModelsTemplate();
  const presets = useModelsPresets();
  const put = usePutModelsTemplate();

  const [providers, setProviders] = useState<DraftProvider[]>([]);
  // The non-provider slices we must preserve when saving (Models page owns them).
  const [carry, setCarry] = useState<{ models: ModelsTemplate['models']; tiers: ModelsTemplate['tiers'] }>(
    { models: {}, tiers: {} },
  );
  const [loadedOnce, setLoadedOnce] = useState(false);

  useEffect(() => {
    if (loadedOnce || !template.data) return;
    const t = template.data.template;
    if (t) {
      setProviders(Object.entries(t.providers).map(([id, p]) => ({
        id,
        presetId: p.presetId,
        apiKey: p.apiKey,
        endpoints: p.endpoints,
        label: p.label,
      })));
      setCarry({ models: t.models ?? {}, tiers: t.tiers ?? {} });
    }
    setLoadedOnce(true);
  }, [template.data, loadedOnce]);

  const buildTemplate = (): ModelsTemplate => {
    const providersOut: ModelsTemplate['providers'] = {};
    for (const p of providers) {
      providersOut[p.id] = {
        presetId: p.presetId,
        apiKey: p.apiKey,
        ...(p.endpoints && (p.endpoints.anthropic || p.endpoints.openai) ? { endpoints: p.endpoints } : {}),
        ...(p.label ? { label: p.label } : {}),
      };
    }
    // Keep model/tier slices, but drop any model that references a provider we
    // just removed (else the template fails validation on save).
    const validModels: ModelsTemplate['models'] = {};
    for (const [mid, m] of Object.entries(carry.models)) {
      const refs = m.providers.filter((r) => providersOut[r.providerId]);
      if (refs.length > 0) validModels[mid] = { ...m, providers: refs };
    }
    const validTiers: ModelsTemplate['tiers'] = {};
    for (const [slot, mid] of Object.entries(carry.tiers)) {
      if (validModels[mid]) validTiers[slot] = mid;
    }
    return { providers: providersOut, models: validModels, tiers: validTiers };
  };

  if (template.error) return <ErrorBanner error={template.error} />;
  if (template.isLoading || presets.isLoading) {
    return <Card bordered><Spinner /></Card>;
  }

  const canSave =
    providers.length > 0 &&
    providers.every((p) => p.apiKey && (p.presetId !== RAW_PRESET_ID || p.endpoints?.anthropic || p.endpoints?.openai));

  return (
    <Card
      bordered
      title={<span className="text-sm font-semibold uppercase tracking-wider">供应商 · Providers</span>}
      extra={
        template.data?.updatedAt && (
          <span className="text-xs" style={{ color: 'var(--color-text-4)' }}>
            updated {new Date(template.data.updatedAt).toLocaleString()}
          </span>
        )
      }
    >
      <p className="text-sm mb-4" style={{ color: 'var(--color-text-3)' }}>
        Token 渠道:选一个供应商预设、粘贴 API key 即可。一个渠道可同时讲两种协议(如 ZenMux),
        路由按模型家族自动选端点,无需手动选协议。具体<strong>模型</strong>在 Models 页创建。
        API key 会复制到每个 worker — 视作机密。
      </p>

      <div className="space-y-4">
        {providers.map((prov, i) => (
          <ProviderEditor
            key={i}
            prov={prov}
            presets={presets.data ?? []}
            onChange={(next) => setProviders((ps) => ps.map((p, j) => (j === i ? next : p)))}
            onRemove={() => setProviders((ps) => ps.filter((_, j) => j !== i))}
          />
        ))}

        <AddProvider
          presets={presets.data ?? []}
          existingIds={new Set(providers.map((p) => p.id))}
          onAdd={(p) => setProviders((ps) => [...ps, p])}
        />

        {put.error && <ErrorBanner error={put.error} />}
        <div className="flex items-center justify-end gap-2">
          {put.isSuccess && <span className="text-xs" style={{ color: 'rgb(var(--green-6))' }}>✓ Saved</span>}
          <Button
            type="primary"
            loading={put.isPending}
            disabled={!canSave}
            onClick={() => put.mutate(buildTemplate(), { onSuccess: () => Message.success('已保存供应商') })}
          >
            保存
          </Button>
        </div>
      </div>
    </Card>
  );
}

function ProviderEditor({
  prov,
  presets,
  onChange,
  onRemove,
}: {
  prov: DraftProvider;
  presets: ModelsPreset[];
  onChange(next: DraftProvider): void;
  onRemove(): void;
}) {
  const preset = presets.find((p) => p.id === prov.presetId);
  const isRaw = prov.presetId === RAW_PRESET_ID;

  return (
    <div className="rounded-md p-3 space-y-2" style={{ border: '1px solid var(--color-border-2)' }}>
      <div className="flex items-center justify-between">
        <div className="font-medium text-sm">
          {prov.label || prov.id}
          {(() => {
            const secondary = preset?.label ?? prov.presetId;
            const primary = prov.label || prov.id;
            return secondary && secondary !== primary ? (
              <span className="font-normal ml-2 text-xs" style={{ color: 'var(--color-text-4)' }}>{secondary}</span>
            ) : null;
          })()}
          {preset && preset.protocols.length > 0 && (
            <span className="ml-2 inline-flex gap-1 align-middle">
              {preset.protocols.map((pr) => (
                <Tag key={pr} size="small" color={pr === 'anthropic' ? 'arcoblue' : undefined}>{pr}</Tag>
              ))}
            </span>
          )}
        </div>
        <Button type="text" size="mini" status="danger" onClick={onRemove}>Remove</Button>
      </div>

      <label className="block text-sm">
        <span className="block text-xs mb-1" style={{ color: 'var(--color-text-3)' }}>API key</span>
        <Input.Password value={prov.apiKey} placeholder="sk-..." onChange={(v) => onChange({ ...prov, apiKey: v })} />
      </label>
      {preset?.apiKeyDocsUrl && (
        <a className="text-xs hover:underline" style={{ color: 'rgb(var(--arcoblue-6))' }} href={preset.apiKeyDocsUrl} target="_blank" rel="noreferrer">
          Where do I get a key? ↗
        </a>
      )}

      {/* Endpoint overrides. Raw providers MUST set at least one; preset
          providers may override the built-in URL (rare). */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {(['anthropic', 'openai'] as const).map((proto) => {
          const presetUrl = preset?.endpoints?.[proto];
          const show = isRaw || presetUrl;
          if (!show) return null;
          return (
            <label key={proto} className="text-sm">
              <span className="block text-xs mb-1" style={{ color: 'var(--color-text-3)' }}>
                {proto} endpoint{isRaw ? '' : ' (override)'}
              </span>
              <Input
                value={prov.endpoints?.[proto] ?? ''}
                placeholder={presetUrl ?? `https://… (${proto})`}
                onChange={(v) => onChange({
                  ...prov,
                  endpoints: { ...prov.endpoints, [proto]: v.trim() || undefined },
                })}
              />
            </label>
          );
        })}
      </div>
    </div>
  );
}

function AddProvider({
  presets,
  existingIds,
  onAdd,
}: {
  presets: ModelsPreset[];
  existingIds: Set<string>;
  onAdd(p: DraftProvider): void;
}) {
  const [presetId, setPresetId] = useState('');

  const add = () => {
    if (!presetId) return;
    const preset = presets.find((p) => p.id === presetId);
    const baseId = preset ? preset.id : 'custom';
    let id = baseId;
    let n = 2;
    while (existingIds.has(id)) id = `${baseId}-${n++}`;
    onAdd({
      id,
      presetId: preset ? preset.id : RAW_PRESET_ID,
      apiKey: '',
      label: preset?.label,
      endpoints: preset ? undefined : { openai: '' },
    });
    setPresetId('');
  };

  // Native <select> keeps this dependency-light; the rich picker is for models.
  return (
    <div className="flex items-end gap-2">
      <label className="text-sm flex-1">
        <span className="block text-xs mb-1" style={{ color: 'var(--color-text-3)' }}>Add provider</span>
        <select
          value={presetId}
          onChange={(e) => setPresetId(e.target.value)}
          className="w-full rounded-md px-3 py-2 text-sm"
          style={{ border: '1px solid var(--color-border-2)', background: 'var(--color-bg-2)', color: 'var(--color-text-1)' }}
        >
          <option value="">Choose a provider…</option>
          {presets.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
          <option value={RAW_PRESET_ID}>Custom (raw endpoint)</option>
        </select>
      </label>
      <Button disabled={!presetId} onClick={add}>Add</Button>
    </div>
  );
}

