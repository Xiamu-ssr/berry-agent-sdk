import { useEffect, useMemo, useState } from 'react';
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
      <PageHeader title="Settings" subtitle="Cluster-wide configuration" />
      <ModelsCard />
      <AdminAgentCard />
    </div>
  );
}

// ============================================================
// Models — human-friendly provider + model configuration
// ============================================================
// The cluster-wide models template (providers / models / tiers) drives
// every worker (they pull it at register). Rather than make the operator
// hand-write that JSON, this card is a form: pick a provider preset, paste
// the API key, pull the live model list, tick the models to expose, and
// map tiers. The JSON is still available under "Advanced" as an escape
// hatch and to edit anything the form doesn't cover.

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
type TierSlot = typeof TIER_SLOTS[number];

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
    return <div className="card"><Spinner /></div>;
  }

  const canSave = providers.length > 0 && providers.every((p) => p.apiKey && p.models.length > 0);

  return (
    <div className="card">
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-ink-500 dark:text-ink-400">
          Models
        </h2>
        <div className="flex items-center gap-3">
          {template.data?.updatedAt && (
            <span className="text-xs text-ink-400">
              updated {new Date(template.data.updatedAt).toLocaleString()}
            </span>
          )}
          <button className="text-xs text-ink-500 hover:underline" onClick={() => setAdvanced((a) => !a)}>
            {advanced ? '← Form' : 'Advanced (JSON)'}
          </button>
        </div>
      </div>
      <p className="text-sm text-ink-500 dark:text-ink-400 mb-4">
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
            <div className="border-t border-ink-200 dark:border-ink-800 pt-3">
              <div className="text-xs font-semibold uppercase tracking-wider text-ink-500 dark:text-ink-400 mb-2">
                Tiers <span className="font-normal normal-case">— map an alias agents request (e.g. <code className="text-xs">tier:strong</code>) to a model</span>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                {TIER_SLOTS.map((slot) => (
                  <label key={slot} className="text-sm">
                    <span className="block text-xs text-ink-500 mb-1">{slot}</span>
                    <select
                      className="input"
                      value={tiers[slot] ?? ''}
                      onChange={(e) => setTiers((t) => ({ ...t, [slot]: e.target.value }))}
                    >
                      <option value="">(none)</option>
                      {allModels.map((m) => <option key={m} value={m}>{m}</option>)}
                    </select>
                  </label>
                ))}
              </div>
            </div>
          )}

          {put.error && <ErrorBanner error={put.error} />}
          <div className="flex items-center justify-end gap-2">
            {put.isSuccess && <span className="text-xs text-emerald-600">✓ Saved</span>}
            <button
              className="btn btn-primary"
              disabled={!canSave || put.isPending}
              onClick={() => put.mutate(buildTemplate())}
            >
              {put.isPending ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      )}
    </div>
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
  const preset = presets.find((p) => p.id === prov.presetId);

  const runProbe = () => {
    probe.mutate(
      { presetId: prov.presetId, apiKey: prov.apiKey, baseUrl: prov.baseUrl },
      { onSuccess: (r) => setAvailable(Array.from(new Set([...r.models, ...prov.models])).sort()) },
    );
  };

  return (
    <div className="rounded-md border border-ink-200 dark:border-ink-800 p-3 space-y-2">
      <div className="flex items-center justify-between">
        <div className="font-medium text-sm">
          {prov.label || prov.id}
          <span className="text-ink-400 font-normal ml-2 text-xs">{preset?.label ?? prov.presetId}</span>
        </div>
        <button className="btn btn-ghost text-xs" onClick={onRemove}>Remove</button>
      </div>

      <label className="block text-sm">
        <span className="block text-xs text-ink-500 mb-1">API key</span>
        <input
          type="password"
          className="input"
          value={prov.apiKey}
          placeholder="sk-..."
          onChange={(e) => onChange({ ...prov, apiKey: e.target.value })}
        />
      </label>
      {preset?.apiKeyDocsUrl && (
        <a className="text-xs text-berry-600 hover:underline" href={preset.apiKeyDocsUrl} target="_blank" rel="noreferrer">
          Where do I get a key? ↗
        </a>
      )}

      <div className="flex items-center gap-2">
        <button
          className="btn btn-default text-xs"
          disabled={!prov.apiKey || probe.isPending}
          onClick={runProbe}
        >
          {probe.isPending ? 'Pulling…' : 'Pull model list'}
        </button>
        {probe.data?.source === 'known' && (
          <span className="text-xs text-amber-600">cached list{probe.data.warning ? ` — ${probe.data.warning}` : ''}</span>
        )}
        {probe.data?.source === 'live' && (
          <span className="text-xs text-emerald-600">✓ {available.length} models</span>
        )}
      </div>
      {probe.error && <FieldError>{probe.error instanceof Error ? probe.error.message : String(probe.error)}</FieldError>}

      {available.length > 0 && (
        <div className="max-h-44 overflow-auto rounded border border-ink-200 dark:border-ink-800 p-2">
          {available.map((m) => {
            const on = prov.models.includes(m);
            return (
              <label key={m} className="flex items-center gap-2 text-sm py-0.5 cursor-pointer">
                <input
                  type="checkbox"
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
        <span className="block text-xs text-ink-500 mb-1">Add provider</span>
        <select className="input" value={presetId} onChange={(e) => setPresetId(e.target.value)}>
          <option value="">Choose a provider…</option>
          {presets.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
        </select>
      </label>
      <button className="btn btn-default" disabled={!presetId} onClick={add}>Add</button>
    </div>
  );
}

function AdvancedJson({ template, onApply }: { template: ModelsTemplate; onApply(t: ModelsTemplate): void }) {
  const [draft, setDraft] = useState(() => JSON.stringify(template, null, 2));
  const [err, setErr] = useState<string | null>(null);
  return (
    <div className="space-y-2">
      <textarea
        className="input font-mono text-xs h-80 resize-y"
        value={draft}
        spellCheck={false}
        onChange={(e) => setDraft(e.target.value)}
      />
      {err && <FieldError>{err}</FieldError>}
      <div className="flex justify-end">
        <button
          className="btn btn-default"
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
        </button>
      </div>
    </div>
  );
}

function FieldError({ children }: { children: React.ReactNode }) {
  return <div className="text-xs text-berry-600 dark:text-berry-400">{children}</div>;
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
    <div className="card">
      <h2 className="text-sm font-semibold uppercase tracking-wider text-ink-500 dark:text-ink-400 mb-2">
        Admin agent
      </h2>
      <p className="text-sm text-ink-500 dark:text-ink-400 mb-3">
        <code className="font-mono text-xs">berry-admin</code> is the chat agent that operates
        the cluster for you (drain workers, generate join scripts, report status). It mounts on an
        active worker and gets the cluster-admin tools automatically.
      </p>

      {status.isLoading ? (
        <Spinner />
      ) : status.data?.present ? (
        <div className="text-sm">
          <span className="pill pill-muted mr-2">running</span>
          mounted on worker <code className="font-mono text-xs">{status.data.workerId}</code>.
          Chat with it on the <strong>Admin chat</strong> page.
        </div>
      ) : (
        <div className="space-y-2">
          {!templateReady && (
            <div className="text-xs text-berry-600 dark:text-berry-400">
              Configure models above first.
            </div>
          )}
          {ensure.error && <ErrorBanner error={ensure.error} />}
          <button
            className="btn btn-primary"
            disabled={!templateReady || ensure.isPending}
            onClick={() => ensure.mutate()}
          >
            {ensure.isPending ? 'Starting…' : 'Bootstrap admin agent'}
          </button>
        </div>
      )}
    </div>
  );
}
