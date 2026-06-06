import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ConfigProvider } from '@arco-design/web-react';
import zhCN from '@arco-design/web-react/es/locale/zh-CN';
import { App } from './App.js';
import './styles/globals.css';
import './styles/arco-theme.css';

// Keep Arco and Tailwind dark mode in lockstep with the OS. Tailwind uses
// darkMode:'media' (auto from prefers-color-scheme); Arco is toggled by a
// body[arco-theme] attribute. Drive the attribute from the same media query,
// BEFORE first paint (not in a useEffect) so there's no light→dark flash.
const prefersDark = window.matchMedia('(prefers-color-scheme: dark)');
const applyTheme = (dark: boolean) =>
  document.body.setAttribute('arco-theme', dark ? 'dark' : 'light');
applyTheme(prefersDark.matches);
prefersDark.addEventListener('change', (e) => applyTheme(e.matches));

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      // Don't retry on auth errors — the AuthError flow handles re-login.
      retryOnMount: false,
      refetchOnWindowFocus: false,
    },
  },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ConfigProvider locale={zhCN}>
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </ConfigProvider>
  </StrictMode>,
);
