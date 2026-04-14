import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ObserveApp } from './components/ObserveApp';
import './app.css';

// Standalone mode: API base URL is same origin (served by observe server)
const baseUrl = '/api/observe';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ObserveApp baseUrl={baseUrl} />
  </StrictMode>,
);
