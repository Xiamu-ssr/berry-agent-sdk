import { useState } from 'react';
import { BarChart3, DollarSign, Zap, Shield, Layers, Cpu, MessageSquare, Bot } from 'lucide-react';
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

export function ObserveApp({ baseUrl }: Props) {
  const [view, setView] = useState<View>({ page: 'overview' });

  const nav = (v: View) => setView(v);

  const breadcrumbs = getBreadcrumbs(view);

  return (
    <div className="flex h-full bg-gray-50">
      {/* Sidebar */}
      <div className="w-48 bg-white border-r border-gray-200 flex flex-col py-4">
        <div className="px-4 mb-4">
          <h2 className="text-sm font-bold text-gray-800">🔬 Observe</h2>
        </div>
        <NavItem icon={<BarChart3 size={16} />} label="Overview" active={view.page === 'overview'} onClick={() => nav({ page: 'overview' })} />
        <NavItem icon={<Cpu size={16} />} label="Inferences" active={view.page === 'inferences' || view.page === 'inference-detail'} onClick={() => nav({ page: 'inferences' })} />
        <NavItem icon={<MessageSquare size={16} />} label="Sessions" active={view.page === 'sessions' || view.page === 'session-detail'} onClick={() => nav({ page: 'sessions' })} />
        <NavItem icon={<Bot size={16} />} label="Agents" active={view.page === 'agents' || view.page === 'agent-detail'} onClick={() => nav({ page: 'agents' })} />
        <NavItem icon={<MessageSquare size={16} />} label="Turns" active={view.page === 'turn-list' || view.page === 'turn-detail'} onClick={() => nav({ page: 'turn-list' })} />
        <div className="h-px bg-gray-200 my-2 mx-4" />
        <NavItem icon={<DollarSign size={16} />} label="Cost" active={view.page === 'cost'} onClick={() => nav({ page: 'cost' })} />
        <NavItem icon={<Zap size={16} />} label="Cache" active={view.page === 'cache'} onClick={() => nav({ page: 'cache' })} />
        <NavItem icon={<Shield size={16} />} label="Guard" active={view.page === 'guard'} onClick={() => nav({ page: 'guard' })} />
        <NavItem icon={<Layers size={16} />} label="Compaction" active={view.page === 'compaction'} onClick={() => nav({ page: 'compaction' })} />
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        {/* Breadcrumbs */}
        {breadcrumbs.length > 1 && (
          <div className="flex items-center gap-1 px-6 pt-4 pb-0 text-xs text-gray-500">
            {breadcrumbs.map((crumb, i) => (
              <span key={i} className="flex items-center gap-1">
                {i > 0 && <span className="text-gray-300">/</span>}
                {i < breadcrumbs.length - 1 ? (
                  <button
                    onClick={() => setView(crumb.view)}
                    className="text-indigo-500 hover:text-indigo-700 hover:underline"
                  >
                    {crumb.label}
                  </button>
                ) : (
                  <span className="text-gray-700 font-medium">{crumb.label}</span>
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
              sessionId={(view as any).sessionId}
              agentId={(view as any).agentId}
              turnId={(view as any).turnId}
              onSelect={(id) => nav({ page: 'inference-detail', id })}
            />
          )}
          {view.page === 'inference-detail' && (
            <InferenceDetail
              baseUrl={baseUrl}
              inferenceId={(view as any).id}
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
              sessionId={(view as any).sessionId}
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
              agentId={(view as any).agentId}
              onBack={() => nav({ page: 'agents' })}
              onSelectSession={(sessionId) => nav({ page: 'session-detail', sessionId })}
            />
          )}

          {view.page === 'turn-list' && (
            <TurnList
              baseUrl={baseUrl}
              sessionId={(view as any).sessionId}
              agentId={(view as any).agentId}
              onSelect={(turnId) => nav({ page: 'turn-detail', turnId })}
            />
          )}
          {view.page === 'turn-detail' && (
            <TurnDetail
              baseUrl={baseUrl}
              turnId={(view as any).turnId}
              onBack={() => nav({ page: 'turn-list' })}
              onSelectInference={(id) => nav({ page: 'inference-detail', id })}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function NavItem({ icon, label, active, onClick }: {
  icon: React.ReactNode; label: string; active: boolean; onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-2 px-4 py-2 text-sm w-full text-left transition-colors ${
        active ? 'bg-indigo-50 text-indigo-700 font-medium' : 'text-gray-600 hover:bg-gray-50'
      }`}
    >
      {icon} {label}
    </button>
  );
}
