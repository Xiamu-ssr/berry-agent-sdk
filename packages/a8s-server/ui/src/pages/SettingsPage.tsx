import { useEffect, useMemo, useState } from 'react';
import {
  useModelsTemplate,
  usePutModelsTemplate,
  useAdminAgentStatus,
  useEnsureAdminAgent,
  type ModelsTemplate,
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
// Models template
// ============================================================
// The template is the single source of truth for LLM providers /
// models / tiers across the cluster. Workers fetch it at register time
// when their local registry is null, so configuring it here means every
// new worker auto-inherits. We edit it as JSON: the shape is wide and
// operator-facing, and a bespoke per-provider form would lag the schema.

const TEMPLATE_PLACEHOLDER = `{
  "providers": {
    "anthropic-main": {
      "presetId": "anthropic",
      "apiKey": "sk-ant-...",
      "label": "Anthropic (prod key)"
    }
  },
  "models": {
    "claude-opus-4-8": {
      "label": "Claude Opus 4.8",
      "contextWindow": 1000000,
      "providers": [{ "providerId": "anthropic-main" }]
    }
  },
  "tiers": {
    "strong": "claude-opus-4-8"
  }
}`;

function ModelsCard() {
  const template = useModelsTemplate();
  const put = usePutModelsTemplate();

  const [draft, setDraft] = useState('');
  const [parseError, setParseError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  // Seed the editor once the server template arrives, unless the operator
  // has already started editing.
  useEffect(() => {
    if (dirty) return;
    if (template.data) {
      setDraft(template.data.template ? JSON.stringify(template.data.template, null, 2) : '');
    }
  }, [template.data, dirty]);

  const validate = (text: string): ModelsTemplate | null => {
    if (!text.trim()) { setParseError('Template is empty.'); return null; }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      setParseError(`Invalid JSON: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
    const t = parsed as Partial<ModelsTemplate>;
    if (!t.providers || !t.models || !t.tiers) {
      setParseError('Template needs top-level "providers", "models", and "tiers" keys.');
      return null;
    }
    setParseError(null);
    return t as ModelsTemplate;
  };

  if (template.error) return <ErrorBanner error={template.error} />;

  return (
    <div className="card">
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-ink-500 dark:text-ink-400">
          Models template
        </h2>
        {template.data?.updatedAt && (
          <span className="text-xs text-ink-400">
            updated {new Date(template.data.updatedAt).toLocaleString()}
          </span>
        )}
      </div>
      <p className="text-sm text-ink-500 dark:text-ink-400 mb-3">
        Providers, models, and tiers shared across the cluster. Workers with{' '}
        <code className="font-mono text-xs">registry: null</code> pull this at register time.
        API keys live here and are copied to each worker — treat this as a secret.
      </p>

      {template.isLoading ? (
        <Spinner />
      ) : (
        <>
          <textarea
            className="input font-mono text-xs h-80 resize-y"
            value={draft}
            placeholder={TEMPLATE_PLACEHOLDER}
            onChange={(e) => {
              setDraft(e.target.value);
              setDirty(true);
              if (parseError) validate(e.target.value);
            }}
            spellCheck={false}
          />
          {parseError && <div className="text-xs text-berry-600 dark:text-berry-400 mt-1">{parseError}</div>}
          {put.error && <div className="mt-2"><ErrorBanner error={put.error} /></div>}
          <div className="flex items-center justify-end gap-2 mt-3">
            {put.isSuccess && !dirty && <span className="text-xs text-emerald-600">✓ Saved</span>}
            <button
              className="btn btn-primary"
              disabled={put.isPending}
              onClick={() => {
                const valid = validate(draft);
                if (!valid) return;
                put.mutate(valid, { onSuccess: () => setDirty(false) });
              }}
            >
              {put.isPending ? 'Saving…' : 'Save template'}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

// ============================================================
// Admin agent bootstrap
// ============================================================
// berry-admin is the cluster operator agent. It needs (1) a configured
// models template so its model ref resolves, and (2) at least one active
// worker to mount on. We gate the button on the template being present;
// the server gates on worker capacity and returns a clear error if none.

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
              Configure the models template above first.
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
