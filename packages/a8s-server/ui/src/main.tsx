import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ConfigProvider } from '@arco-design/web-react';
import zhCN from '@arco-design/web-react/es/locale/zh-CN';
import { App } from './App.js';
import './styles/globals.css';
import './styles/arco-theme.css';

// 雪山引擎 follows 火山引擎 (Volcano Engine): a LIGHT, clean console — white
// canvas, pale-gray sidebar, blue only as accent. We pin light mode (Arco's
// body[arco-theme='light']) regardless of OS, so the brand identity is the same
// everywhere and doesn't flip to dark on machines whose OS prefers dark.
document.body.setAttribute('arco-theme', 'light');

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
