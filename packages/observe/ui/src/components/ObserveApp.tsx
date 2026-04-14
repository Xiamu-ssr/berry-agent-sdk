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
import { AgentDashboard } from './AgentDashboard';

type View =
  | { page: 'overview' }
  | { page: 'cost' }
  | { page: 'cache' }
  | { page: 'guard' }
  | { page: 'compaction' }
  | { page: 'inferences'; sessionId?: string }
  | { page: 'inference-detail'; id: string }
  | { page: 'sessions' }
  | { page: 'agents' };

interface Props {
  baseUrl: string;
}

export function ObserveApp({ baseUrl }: Props) {
  const [view, setView] = useState<View>({ page: 'overview' });

  const nav = (page: View['page']) => setView({ page } as View);

  return (
    <div className="flex h-full bg-gray-50">
      {/* Sidebar */}
      <div className="w-48 bg-white border-r border-gray-200 flex flex-col py-4">
        <div className="px-4 mb-4">
          <h2 className="text-sm font-bold text-gray-800">🔬 Observe</h2>
        </div>
        <NavItem icon={<BarChart3 size={16} />} label="Overview" active={view.page === 'overview'} onClick={() => nav('overview')} />
        <NavItem icon={<Cpu size={16} />} label="Inferences" active={view.page === 'inferences' || view.page === 'inference-detail'} onClick={() => setView({ page: 'inferences' })} />
        <NavItem icon={<MessageSquare size={16} />} label="Sessions" active={view.page === 'sessions'} onClick={() => nav('sessions')} />
        <NavItem icon={<Bot size={16} />} label="Agents" active={view.page === 'agents'} onClick={() => nav('agents')} />
        <div className="h-px bg-gray-200 my-2 mx-4" />
        <NavItem icon={<DollarSign size={16} />} label="Cost" active={view.page === 'cost'} onClick={() => nav('cost')} />
        <NavItem icon={<Zap size={16} />} label="Cache" active={view.page === 'cache'} onClick={() => nav('cache')} />
        <NavItem icon={<Shield size={16} />} label="Guard" active={view.page === 'guard'} onClick={() => nav('guard')} />
        <NavItem icon={<Layers size={16} />} label="Compaction" active={view.page === 'compaction'} onClick={() => nav('compaction')} />
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-6">
        {view.page === 'overview' && (
          <GlobalDashboard
            baseUrl={baseUrl}
            onNavigate={(path) => {
              const page = path.replace('/', '') as View['page'];
              nav(page);
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
            onSelect={(id) => setView({ page: 'inference-detail', id })}
          />
        )}
        {view.page === 'inference-detail' && (
          <InferenceDetail
            baseUrl={baseUrl}
            inferenceId={(view as any).id}
            onBack={() => setView({ page: 'inferences' })}
          />
        )}
        {view.page === 'sessions' && (
          <SessionList
            baseUrl={baseUrl}
            onSelect={(sid) => setView({ page: 'inferences', sessionId: sid })}
          />
        )}
        {view.page === 'agents' && (
          <AgentDashboard baseUrl={baseUrl} />
        )}
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
