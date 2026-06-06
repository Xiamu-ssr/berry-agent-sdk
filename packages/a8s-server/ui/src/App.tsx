import { useEffect, useState } from 'react';
import { Sidebar, VIEW_LABEL, type View } from './components/Sidebar.js';
import { TokenModal } from './components/TokenModal.js';
import { Topbar } from './components/Topbar.js';
import { getToken } from './api/client.js';
import { DashboardPage } from './pages/DashboardPage.js';
import { WorkersPage } from './pages/WorkersPage.js';
import { MachinesPage } from './pages/MachinesPage.js';
import { LeasesPage } from './pages/LeasesPage.js';
import { AgentsPage } from './pages/AgentsPage.js';
import { WakesPage } from './pages/WakesPage.js';
import { AdminChatPage } from './pages/AdminChatPage.js';
import { SettingsPage } from './pages/SettingsPage.js';
import { CredentialsPage } from './pages/CredentialsPage.js';
import { AuditPage } from './pages/AuditPage.js';

export function App() {
  const [view, setView] = useState<View>('dashboard');
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
    <div className="h-full flex">
      <Sidebar view={view} onSelect={setView} />
      <div className="flex-1 flex flex-col min-w-0">
        <Topbar title={VIEW_LABEL[view]} onLogout={() => setHasToken(false)} />
        <main className="flex-1 overflow-y-auto p-6 max-w-7xl mx-auto w-full">
          {view === 'dashboard' && <DashboardPage />}
          {view === 'agents' && <AgentsPage />}
          {view === 'admin' && <AdminChatPage />}
          {view === 'workers' && <WorkersPage />}
          {view === 'machines' && <MachinesPage />}
          {view === 'leases' && <LeasesPage />}
          {view === 'wakes' && <WakesPage />}
          {view === 'models' && <SettingsPage />}
          {view === 'credentials' && <CredentialsPage />}
          {view === 'audit' && <AuditPage />}
        </main>
      </div>
    </div>
  );
}
