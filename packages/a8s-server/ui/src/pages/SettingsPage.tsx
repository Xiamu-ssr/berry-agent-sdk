import { useEffect, useMemo, useState } from 'react';
import { Card, Button, Input, Select, Checkbox, Tag, Message } from '@arco-design/web-react';
import {
  useModelsTemplate,
  usePutModelsTemplate,
  useModelsPresets,
  useProbeModels,
  useAdminAgentStatus,
  useEnsureAdminAgent,
  type ModelsTemplate,
  type ModelsPreset,
} from '../api/queries.js';
import { PageHeader, ErrorBanner, Spinner } from '../components/Page.js';

export function SettingsPage() {
  return (
    <div className="animate-fade-in space-y-6">
      <PageHeader title="Models" subtitle="Providers, models & tiers — the cluster-wide template every worker pulls" />
      <ModelsCard />
      <AdminAgentCard />
    </div>
  );
}

// ============================================================
// Models — human-friendly provider + model configuration
// ============================================================
// The cluster-wide models template (providers / models / tiers) drives every
// worker (they pull it at register). Rather than make the operator hand-write
// that JSON, this card is a form: pick a provider preset, paste the API key,
// pull the live model list, tick the models to expose, and map tiers. The JSON
// is still available under "Advanced" as an escape hatch.

interface DraftProvider {
  /** Local key in the template's providers map. */
  id: string;
  presetId: string;
  apiKey: string;
  baseUrl?: string;
  label?: string;
  /** Model ids the operator ticked for this provider. */
  models: string[];
}

const TIER_SLOTS = ['strong', 'fast', 'cheap'] as const;

function ModelsCard() {
  const template = useModelsTemplate();
  const presets = useModelsPresets();
  const put = usePutModelsTemplate();

  const [providers, setProviders] = useState<DraftProvider[]>([]);
  const [tiers, setTiers] = useState<Record<string, string>>({});
  const [advanced, setAdvanced] = useState(false);
  const [loadedOnce, setLoadedOnce] = useState(false);

  // Hydrate the form from the saved template once.
  useEffect(() => {
    if (loadedOnce || !template.data) return;
    const t = template.data.template;
    if (t) {
      const provs: DraftProvider[] = Object.entries(t.providers).map(([id, p]) => ({
        id,
        presetId: p.presetId,
        apiKey: p.apiKey,
        baseUrl: p.baseUrl,
        label: p.label,
        models: Object.entries(t.models)
          .filter(([, m]) => m.providers.some((mp) => mp.providerId === id))
          .map(([modelId]) => modelId),
      }));
      setProviders(provs);
      setTiers(t.tiers ?? {});
    }
    setLoadedOnce(true);
  }, [template.data, loadedOnce]);

  // Every ticked model across all providers — the tier dropdowns choose from these.
  const allModels = useMemo(
    () => Array.from(new Set(providers.flatMap((p) => p.models))).sort(),
    [providers],
  );

  // Compose the wire template from the form state.
  const buildTemplate = (): ModelsTemplate => {
    const providersOut: ModelsTemplate['providers'] = {};
    const modelsOut: ModelsTemplate['models'] = {};
    for (const p of providers) {
      providersOut[p.id] = {
        presetId: p.presetId,
        apiKey: p.apiKey,
        ...(p.baseUrl ? { baseUrl: p.baseUrl } : {}),
        ...(p.label ? { label: p.label } : {}),
      };
      for (const modelId of p.models) {
        // A model exposed by multiple providers gets both as fallbacks.
        const existing = modelsOut[modelId];
        if (existing) existing.providers.push({ providerId: p.id });
        else modelsOut[modelId] = { providers: [{ providerId: p.id }] };
      }
    }
    const tiersOut: Record<string, string> = {};
    for (const [slot, modelId] of Object.entries(tiers)) {
      if (modelId && modelsOut[modelId]) tiersOut[slot] = modelId;
    }
    return { providers: providersOut, models: modelsOut, tiers: tiersOut };
  };

  if (template.error) return <ErrorBanner error={template.error} />;
  if (template.isLoading || presets.isLoading) {
    return <Card bordered><Spinner /></Card>;
  }

  const canSave = providers.length > 0 && providers.every((p) => p.apiKey && p.models.length > 0);

  return (
    <Card
      bordered
      title={<span className="text-sm font-semibold uppercase tracking-wider">Models</span>}
      extra={
        <div className="flex items-center gap-3">
          {template.data?.updatedAt && (
            <span className="text-xs" style={{ color: 'var(--color-text-4)' }}>
              updated {new Date(template.data.updatedAt).toLocaleString()}
            </span>
          )}
          <Button type="text" size="small" onClick={() => setAdvanced((a) => !a)}>
            {advanced ? '← Form' : 'Advanced (JSON)'}
          </Button>
        </div>
      }
    >
      <p className="text-sm mb-4" style={{ color: 'var(--color-text-3)' }}>
        Providers and models shared across the cluster. Workers pull this at register time. API keys
        are copied to each worker — treat this as a secret.
      </p>

      {advanced ? (
        <AdvancedJson
          template={buildTemplate()}
          onApply={(t) => {
            // Re-hydrate the form from edited JSON.
            setProviders(Object.entries(t.providers).map(([id, p]) => ({
              id, presetId: p.presetId, apiKey: p.apiKey, baseUrl: p.baseUrl, label: p.label,
              models: Object.entries(t.models).filter(([, m]) => m.providers.some((mp) => mp.providerId === id)).map(([mid]) => mid),
            })));
            setTiers(t.tiers ?? {});
          }}
        />
      ) : (
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

          {allModels.length > 0 && (
            <div className="pt-3" style={{ borderTop: '1px solid var(--color-border-2)' }}>
              <div className="text-xs font-semibold uppercase tracking-wider mb-2" style={{ color: 'var(--color-text-3)' }}>
                Tiers <span className="font-normal normal-case">— map an alias agents request (e.g. <code className="text-xs">tier:strong</code>) to a model</span>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                {TIER_SLOTS.map((slot) => (
                  <label key={slot} className="text-sm">
                    <span className="block text-xs mb-1" style={{ color: 'var(--color-text-3)' }}>{slot}</span>
                    <Select
                      value={tiers[slot] ?? ''}
                      onChange={(v) => setTiers((t) => ({ ...t, [slot]: v }))}
                      allowClear
                      placeholder="(none)"
                    >
                      {allModels.map((m) => <Select.Option key={m} value={m}>{m}</Select.Option>)}
                    </Select>
                  </label>
                ))}
              </div>
            </div>
          )}

          {put.error && <ErrorBanner error={put.error} />}
          <div className="flex items-center justify-end gap-2">
            {put.isSuccess && <span className="text-xs" style={{ color: 'rgb(var(--green-6))' }}>✓ Saved</span>}
            <Button
              type="primary"
              loading={put.isPending}
              disabled={!canSave}
              onClick={() => put.mutate(buildTemplate(), { onSuccess: () => Message.success('已保存 models 模板') })}
            >
              保存
            </Button>
          </div>
        </div>
      )}
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
  const probe = useProbeModels();
  const [available, setAvailable] = useState<string[]>(prov.models);
  const [manual, setManual] = useState('');
  const preset = presets.find((p) => p.id === prov.presetId);

  const runProbe = () => {
    probe.mutate(
      { presetId: prov.presetId, apiKey: prov.apiKey, baseUrl: prov.baseUrl },
      { onSuccess: (r) => setAvailable(Array.from(new Set([...r.models, ...prov.models])).sort()) },
    );
  };

  const addManual = () => {
    const id = manual.trim();
    if (!id) return;
    setAvailable((a) => Array.from(new Set([...a, id])).sort());
    if (!prov.models.includes(id)) onChange({ ...prov, models: [...prov.models, id] });
    setManual('');
  };

  // The probe fell back to a hardcoded list (live fetch failed or the provider
  // has no /models endpoint). Showing that as if "pulled" is worse than nothing
  // — flag it and steer to manual entry.
  const isCached = probe.data?.source === 'known';

  return (
    <div className="rounded-md p-3 space-y-2" style={{ border: '1px solid var(--color-border-2)' }}>
      <div className="flex items-center justify-between">
        <div className="font-medium text-sm">
          {prov.label || prov.id}
          <span className="font-normal ml-2 text-xs" style={{ color: 'var(--color-text-4)' }}>{preset?.label ?? prov.presetId}</span>
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

      <div className="flex items-center gap-2 flex-wrap">
        <Button size="small" disabled={!prov.apiKey} loading={probe.isPending} onClick={runProbe}>
          Pull model list
        </Button>
        {probe.data?.source === 'live' && (
          <span className="text-xs" style={{ color: 'rgb(var(--green-6))' }}>✓ {available.length} live models</span>
        )}
        {isCached && (
          <span className="text-xs" style={{ color: 'rgb(var(--orange-6))' }}>
            ⚠ couldn't pull a live list{probe.data?.warning ? ` (${probe.data.warning})` : ''} — type model ids below
          </span>
        )}
      </div>
      {probe.error && <FieldError>{probe.error instanceof Error ? probe.error.message : String(probe.error)}</FieldError>}

      {/* Manual model-id entry — always available, the reliable path when a
          provider has no catalog endpoint or returns the wrong shape. */}
      <div className="flex items-end gap-2">
        <label className="text-sm flex-1">
          <span className="block text-xs mb-1" style={{ color: 'var(--color-text-3)' }}>Add model id manually</span>
          <Input
            value={manual}
            placeholder="e.g. anthropic/claude-opus-4.7"
            onChange={setManual}
            onPressEnter={addManual}
          />
        </label>
        <Button disabled={!manual.trim()} onClick={addManual}>Add</Button>
      </div>

      {available.length > 0 && (
        <div className="max-h-44 overflow-auto rounded p-2" style={{ border: '1px solid var(--color-border-2)' }}>
          {available.map((m) => {
            const on = prov.models.includes(m);
            return (
              <label key={m} className="flex items-center gap-2 text-sm py-0.5 cursor-pointer">
                <Checkbox
                  checked={on}
                  onChange={() => onChange({
                    ...prov,
                    models: on ? prov.models.filter((x) => x !== m) : [...prov.models, m],
                  })}
                />
                <code className="text-xs">{m}</code>
              </label>
            );
          })}
        </div>
      )}
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
    const preset = presets.find((p) => p.id === presetId);
    if (!preset) return;
    // Unique local id: preset id, then preset-2 etc. on collision.
    let id = preset.id;
    let n = 2;
    while (existingIds.has(id)) id = `${preset.id}-${n++}`;
    onAdd({ id, presetId: preset.id, apiKey: '', label: preset.label, models: [] });
    setPresetId('');
  };

  return (
    <div className="flex items-end gap-2">
      <label className="text-sm flex-1">
        <span className="block text-xs mb-1" style={{ color: 'var(--color-text-3)' }}>Add provider</span>
        <Select value={presetId} onChange={setPresetId} placeholder="Choose a provider…">
          {presets.map((p) => <Select.Option key={p.id} value={p.id}>{p.label}</Select.Option>)}
        </Select>
      </label>
      <Button disabled={!presetId} onClick={add}>Add</Button>
    </div>
  );
}

function AdvancedJson({ template, onApply }: { template: ModelsTemplate; onApply(t: ModelsTemplate): void }) {
  const [draft, setDraft] = useState(() => JSON.stringify(template, null, 2));
  const [err, setErr] = useState<string | null>(null);
  return (
    <div className="space-y-2">
      <Input.TextArea
        className="font-mono"
        value={draft}
        spellCheck={false}
        onChange={setDraft}
        style={{ height: 320, fontSize: 12, resize: 'vertical' }}
      />
      {err && <FieldError>{err}</FieldError>}
      <div className="flex justify-end">
        <Button
          onClick={() => {
            try {
              const t = JSON.parse(draft) as ModelsTemplate;
              if (!t.providers || !t.models || !t.tiers) throw new Error('need providers, models, tiers');
              setErr(null);
              onApply(t);
            } catch (e) {
              setErr(e instanceof Error ? e.message : String(e));
            }
          }}
        >
          Apply to form
        </Button>
      </div>
    </div>
  );
}

function FieldError({ children }: { children: React.ReactNode }) {
  return <div className="text-xs" style={{ color: 'rgb(var(--red-6))' }}>{children}</div>;
}

// ============================================================
// Admin agent bootstrap
// ============================================================

function AdminAgentCard() {
  const status = useAdminAgentStatus();
  const template = useModelsTemplate();
  const ensure = useEnsureAdminAgent();

  const templateReady = useMemo(() => !!template.data?.template, [template.data]);

  return (
    <Card bordered title={<span className="text-sm font-semibold uppercase tracking-wider">Admin agent</span>}>
      <p className="text-sm mb-3" style={{ color: 'var(--color-text-3)' }}>
        <code className="font-mono text-xs">berry-admin</code> is the chat agent that operates
        the cluster for you (drain workers, generate join scripts, report status). It mounts on an
        active worker and gets the cluster-admin tools automatically.
      </p>

      {status.isLoading ? (
        <Spinner />
      ) : status.data?.present ? (
        <div className="text-sm flex items-center gap-2">
          <Tag color="green" size="small">running</Tag>
          mounted on worker <code className="font-mono text-xs">{status.data.workerId}</code>.
          Chat with it on the <strong>Admin chat</strong> page.
        </div>
      ) : (
        <div className="space-y-2">
          {!templateReady && (
            <div className="text-xs" style={{ color: 'rgb(var(--red-6))' }}>
              Configure models above first.
            </div>
          )}
          {ensure.error && <ErrorBanner error={ensure.error} />}
          <Button
            type="primary"
            loading={ensure.isPending}
            disabled={!templateReady}
            onClick={() => ensure.mutate()}
          >
            Bootstrap admin agent
          </Button>
        </div>
      )}
    </Card>
  );
}
