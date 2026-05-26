import { useState, useEffect } from 'react';
import { BarChart3, DollarSign, Zap, Shield, Layers, Cpu, MessageSquare, Bot } from 'lucide-react';
import { ObserveFetcherContext } from '../hooks/useObserve';
import { GlobalDashboard } from './GlobalDashboard';
import { CostTrend } from './CostTrend';
import { CacheEfficiency } from './CacheEfficiency';
import { ToolGuardAudit } from './ToolGuardAudit';
import { CompactionAnalysis } from './CompactionAnalysis';
import { InferenceList } from './InferenceList';
import { InferenceDetail } from './InferenceDetail';
import { SessionList } from './SessionList';
import { SessionDetail } from './SessionDetail';
import { AgentDashboard } from './AgentDashboard';
import { AgentDetail } from './AgentDetail';
import { TurnList } from './TurnList';
import { TurnDetail } from './TurnDetail';

type View =
  | { page: 'overview' }
  | { page: 'cost' }
  | { page: 'cache' }
  | { page: 'guard' }
  | { page: 'compaction' }
  | { page: 'inferences'; sessionId?: string; agentId?: string; turnId?: string }
  | { page: 'inference-detail'; id: string }
  | { page: 'sessions' }
  | { page: 'session-detail'; sessionId: string }
  | { page: 'agents' }
  | { page: 'agent-detail'; agentId: string }
  | { page: 'turn-list'; sessionId?: string; agentId?: string }
  | { page: 'turn-detail'; turnId: string };

interface Props {
  baseUrl: string;
  /**
   * Optional authenticated fetch wrapper. When provided, every
   * `useObserveApi` call inside this subtree goes through it instead of
   * `window.fetch` — lets host apps attach bearer tokens etc. without
   * forking the whole component tree.
   */
  fetcher?: typeof fetch;
}

type BreadcrumbItem = { label: string; view: View };

function getBreadcrumbs(view: View): BreadcrumbItem[] {
  const home: BreadcrumbItem = { label: 'Overview', view: { page: 'overview' } };
  switch (view.page) {
    case 'overview': return [home];
    case 'cost': return [home, { label: 'Cost', view }];
    case 'cache': return [home, { label: 'Cache', view }];
    case 'guard': return [home, { label: 'Guard', view }];
    case 'compaction': return [home, { label: 'Compaction', view }];
    case 'sessions': return [home, { label: 'Sessions', view }];
    case 'session-detail': return [home, { label: 'Sessions', view: { page: 'sessions' } }, { label: view.sessionId.slice(0, 12) + '...', view }];
    case 'agents': return [home, { label: 'Agents', view }];
    case 'agent-detail': return [home, { label: 'Agents', view: { page: 'agents' } }, { label: view.agentId, view }];
    case 'inferences': return [home, { label: 'Inferences', view }];
    case 'inference-detail': return [home, { label: 'Inferences', view: { page: 'inferences' } }, { label: view.id.slice(0, 12) + '...', view }];
    case 'turn-list': return [home, { label: 'Turns', view }];
    case 'turn-detail': return [home, { label: 'Turns', view: { page: 'turn-list' } }, { label: view.turnId.slice(0, 12) + '...', view }];
    default: return [home];
  }
}

export function ObserveApp({ baseUrl, fetcher }: Props) {
  const [view, setView] = useState<View>({ page: 'overview' });

  // Detect dark mode from parent app (check .dark class or data-theme on root).
  // Observed via MutationObserver so toggling the parent's dark class updates
  // the Observe subtree live. We do NOT mutate the root element ourselves.
  const [isDark, setIsDark] = useState(false);
  useEffect(() => {
    const root = document.documentElement;
    const compute = () =>
      root.classList.contains('dark')
      || root.getAttribute('data-theme') === 'dark'
      || window.matchMedia('(prefers-color-scheme: dark)').matches;
    setIsDark(compute());
    const observer = new MutationObserver(() => setIsDark(compute()));
    observer.observe(root, { attributes: true, attributeFilter: ['class', 'data-theme'] });
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onMedia = () => setIsDark(compute());
    media.addEventListener?.('change', onMedia);
    return () => {
      observer.disconnect();
      media.removeEventListener?.('change', onMedia);
    };
  }, []);

  const nav = (v: View) => setView(v);

  const breadcrumbs = getBreadcrumbs(view);
  const shellClass = isDark
    ? 'dark bg-[#1b1e22] text-zinc-200'
    : 'bg-gray-50 text-gray-900';

  const tree = (
    <div
      className={`flex h-full min-h-0 overflow-hidden ${shellClass}`}
      data-theme={isDark ? 'dark' : 'light'}
    >
      {/* Sidebar */}
      <div className="flex w-52 flex-col border-r border-gray-200 bg-white py-4 dark:border-white/[0.07] dark:bg-[#15171a]">
        <div className="mb-4 px-4">
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg border border-blue-200 bg-blue-50 text-blue-600 dark:border-sky-300/25 dark:bg-sky-300/10 dark:text-sky-200">
              <BarChart3 size={16} />
            </div>
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-gray-900 dark:text-zinc-100">Observe</h2>
              <p className="truncate text-[11px] text-gray-500 dark:text-zinc-500">SDK telemetry</p>
            </div>
          </div>
        </div>
        <NavItem icon={<BarChart3 size={16} />} label="Overview" active={view.page === 'overview'} onClick={() => nav({ page: 'overview' })} />
        <div className="mb-1 mt-3 px-4"><span className="text-[11px] font-medium uppercase tracking-wide text-gray-500 dark:text-zinc-600">Records</span></div>
        <NavItem icon={<Bot size={16} />} label="Agents" active={view.page === 'agents' || view.page === 'agent-detail'} onClick={() => nav({ page: 'agents' })} />
        <NavItem icon={<MessageSquare size={16} />} label="Sessions" active={view.page === 'sessions' || view.page === 'session-detail'} onClick={() => nav({ page: 'sessions' })} />
        <NavItem icon={<MessageSquare size={16} />} label="Turns" active={view.page === 'turn-list' || view.page === 'turn-detail'} onClick={() => nav({ page: 'turn-list' })} />
        <NavItem icon={<Cpu size={16} />} label="Inferences" active={view.page === 'inferences' || view.page === 'inference-detail'} onClick={() => nav({ page: 'inferences' })} />
        <div className="mb-1 mt-3 px-4"><span className="text-[11px] font-medium uppercase tracking-wide text-gray-500 dark:text-zinc-600">Analytics</span></div>
        <NavItem icon={<DollarSign size={16} />} label="Cost" active={view.page === 'cost'} onClick={() => nav({ page: 'cost' })} />
        <NavItem icon={<Zap size={16} />} label="Cache" active={view.page === 'cache'} onClick={() => nav({ page: 'cache' })} />
        <NavItem icon={<Shield size={16} />} label="Guard" active={view.page === 'guard'} onClick={() => nav({ page: 'guard' })} />
        <NavItem icon={<Layers size={16} />} label="Compaction" active={view.page === 'compaction'} onClick={() => nav({ page: 'compaction' })} />
      </div>

      {/* Content */}
      <div className="min-w-0 flex-1 overflow-y-auto bg-gray-50 dark:bg-[#1b1e22]">
        {/* Breadcrumbs */}
        {breadcrumbs.length > 1 && (
          <div className="flex items-center gap-1 border-b border-gray-200 bg-white/70 px-6 py-3 text-xs text-gray-500 backdrop-blur dark:border-white/[0.07] dark:bg-[#1d2126]/90 dark:text-zinc-500">
            {breadcrumbs.map((crumb, i) => (
              <span key={i} className="flex items-center gap-1">
                {i > 0 && <span className="text-gray-300 dark:text-zinc-700">/</span>}
                {i < breadcrumbs.length - 1 ? (
                  <button
                    onClick={() => setView(crumb.view)}
                    className="text-blue-600 hover:text-blue-700 hover:underline dark:text-sky-300 dark:hover:text-sky-100"
                  >
                    {crumb.label}
                  </button>
                ) : (
                  <span className="font-medium text-gray-700 dark:text-zinc-200">{crumb.label}</span>
                )}
              </span>
            ))}
          </div>
        )}

        <div className="p-6">
          {view.page === 'overview' && (
            <GlobalDashboard
              baseUrl={baseUrl}
              onNavigate={(path) => {
                const page = path.replace('/', '') as View['page'];
                nav({ page } as View);
              }}
            />
          )}
          {view.page === 'cost' && <CostTrend baseUrl={baseUrl} />}
          {view.page === 'cache' && <CacheEfficiency baseUrl={baseUrl} />}
          {view.page === 'guard' && <ToolGuardAudit baseUrl={baseUrl} />}
          {view.page === 'compaction' && <CompactionAnalysis baseUrl={baseUrl} />}

          {view.page === 'inferences' && (
            <InferenceList
              baseUrl={baseUrl}
              sessionId={view.sessionId}
              agentId={view.agentId}
              turnId={view.turnId}
              onSelect={(id) => nav({ page: 'inference-detail', id })}
            />
          )}
          {view.page === 'inference-detail' && (
            <InferenceDetail
              baseUrl={baseUrl}
              inferenceId={view.id}
              onBack={() => nav({ page: 'inferences' })}
            />
          )}

          {view.page === 'sessions' && (
            <SessionList
              baseUrl={baseUrl}
              onSelect={(sid) => nav({ page: 'session-detail', sessionId: sid })}
            />
          )}
          {view.page === 'session-detail' && (
            <SessionDetail
              baseUrl={baseUrl}
              sessionId={view.sessionId}
              onBack={() => nav({ page: 'sessions' })}
              onSelectTurn={(turnId) => nav({ page: 'turn-detail', turnId })}
              onSelectInference={(id) => nav({ page: 'inference-detail', id })}
            />
          )}

          {view.page === 'agents' && (
            <AgentDashboard
              baseUrl={baseUrl}
              onSelectAgent={(agentId) => nav({ page: 'agent-detail', agentId })}
            />
          )}
          {view.page === 'agent-detail' && (
            <AgentDetail
              baseUrl={baseUrl}
              agentId={view.agentId}
              onBack={() => nav({ page: 'agents' })}
              onSelectSession={(sessionId) => nav({ page: 'session-detail', sessionId })}
            />
          )}

          {view.page === 'turn-list' && (
            <TurnList
              baseUrl={baseUrl}
              sessionId={view.sessionId}
              agentId={view.agentId}
              onSelect={(turnId) => nav({ page: 'turn-detail', turnId })}
            />
          )}
          {view.page === 'turn-detail' && (
            <TurnDetail
              baseUrl={baseUrl}
              turnId={view.turnId}
              onBack={() => nav({ page: 'turn-list' })}
              onSelectInference={(id) => nav({ page: 'inference-detail', id })}
            />
          )}
        </div>
      </div>
    </div>
  );

  return fetcher ? (
    <ObserveFetcherContext.Provider value={fetcher}>{tree}</ObserveFetcherContext.Provider>
  ) : tree;
}

function NavItem({ icon, label, active, onClick }: {
  icon: React.ReactNode; label: string; active: boolean; onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex w-full items-center gap-2 border-l-2 px-4 py-2 text-left text-sm transition-colors ${
        active
          ? 'border-blue-500 bg-blue-50 font-medium text-blue-700 dark:border-sky-300 dark:bg-sky-300/10 dark:text-sky-100'
          : 'border-transparent text-gray-600 hover:bg-gray-50 dark:text-zinc-500 dark:hover:bg-sky-200/[0.06] dark:hover:text-sky-100'
      }`}
    >
      {icon} {label}
    </button>
  );
}
