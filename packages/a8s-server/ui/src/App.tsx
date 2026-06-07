import { useEffect, useState } from 'react';
import { Layout } from '@arco-design/web-react';
import { Sidebar, VIEW_LABEL, type View } from './components/Sidebar.js';
import { TokenModal } from './components/TokenModal.js';
import { Topbar } from './components/Topbar.js';
import { getToken } from './api/client.js';
import { DashboardPage } from './pages/DashboardPage.js';
import { WorkersPage } from './pages/WorkersPage.js';
import { MachinesPage } from './pages/MachinesPage.js';
import { LeasesPage } from './pages/LeasesPage.js';
import { AgentsPage } from './pages/AgentsPage.js';
import { HandsPage } from './pages/HandsPage.js';
import { SkillsPage } from './pages/SkillsPage.js';
import { WakesPage } from './pages/WakesPage.js';
import { AdminChatPage } from './pages/AdminChatPage.js';
import { SettingsPage } from './pages/SettingsPage.js';
import { CredentialsPage } from './pages/CredentialsPage.js';
import { AuditPage } from './pages/AuditPage.js';

export function App() {
  const [view, setView] = useState<View>('dashboard');
  const [collapsed, setCollapsed] = useState(false);
  const [hasToken, setHasToken] = useState<boolean>(() => !!getToken());

  // Listen for auth failures so any component throwing AuthError will
  // re-open the modal. The query client surfaces these via onError
  // hooks; we just poll localStorage for now (simple, robust).
  useEffect(() => {
    const tick = setInterval(() => setHasToken(!!getToken()), 1000);
    return () => clearInterval(tick);
  }, []);

  if (!hasToken) {
    return <TokenModal onSubmit={() => setHasToken(true)} />;
  }

  return (
    <Layout className="h-full" hasSider>
      <Sidebar view={view} onSelect={setView} collapsed={collapsed} onCollapse={setCollapsed} />
      <Layout>
        <Topbar title={VIEW_LABEL[view]} onLogout={() => setHasToken(false)} />
        <Layout.Content style={{ overflowY: 'auto', background: 'var(--color-bg-1)' }}>
          <div className="p-6 max-w-7xl mx-auto w-full">
            {view === 'dashboard' && <DashboardPage />}
            {view === 'agents' && <AgentsPage />}
            {view === 'hands' && <HandsPage />}
            {view === 'skills' && <SkillsPage />}
            {view === 'admin' && <AdminChatPage />}
            {view === 'workers' && <WorkersPage />}
            {view === 'machines' && <MachinesPage />}
            {view === 'leases' && <LeasesPage />}
            {view === 'wakes' && <WakesPage />}
            {view === 'models' && <SettingsPage />}
            {view === 'credentials' && <CredentialsPage />}
            {view === 'audit' && <AuditPage />}
          </div>
        </Layout.Content>
      </Layout>
    </Layout>
  );
}
