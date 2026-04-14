// ============================================================
// Berry Agent SDK — Observe: Standalone Server
// ============================================================
// Start a standalone HTTP server that serves both the observe API and UI.
// Usage:
//   import { createObserver, startObserveServer } from '@berry-agent/observe';
//   const observer = createObserver({ dbPath: './observe.db' });
//   startObserveServer(observer, { port: 4200 });
//   // → http://localhost:4200  (UI dashboard)
//   // → http://localhost:4200/api/observe/*  (REST API)

import express from 'express';
import { createServer } from 'node:http';
import { resolve, join } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createObserveRouter } from './server.js';
import type { Observer } from './observer.js';

export interface StandaloneOptions {
  /** Port to listen on (default: 4200) */
  port?: number;
  /** Hostname to bind to (default: '0.0.0.0') */
  host?: string;
  /** Enable CORS (default: true) */
  cors?: boolean;
}

/**
 * Start a standalone observe server with built-in UI.
 * Serves the observe API at /api/observe/* and the dashboard UI at /.
 */
export function startObserveServer(observer: Observer, options?: StandaloneOptions) {
  const port = options?.port ?? 4200;
  const host = options?.host ?? '0.0.0.0';

  const app = express();

  if (options?.cors !== false) {
    app.use((_req, res, next) => {
      res.header('Access-Control-Allow-Origin', '*');
      res.header('Access-Control-Allow-Headers', 'Content-Type');
      next();
    });
  }

  app.use(express.json());

  // API routes
  app.use('/api/observe', createObserveRouter(observer));

  // Serve built UI (dist-app from vite build:app)
  const __dirname = fileURLToPath(new URL('.', import.meta.url));
  const uiDist = resolve(__dirname, '../ui/dist-app');
  if (existsSync(uiDist)) {
    app.use(express.static(uiDist));
    app.get('/{*splat}', (_req, res) => {
      res.sendFile(join(uiDist, 'index.html'));
    });
  } else {
    app.get('/', (_req, res) => {
      res.send(`
        <html><body style="font-family:system-ui;padding:40px">
          <h2>🍓 Berry Agent — Observe</h2>
          <p>API is running at <code>/api/observe/*</code></p>
          <p>UI not built yet. Run: <code>cd packages/observe/ui && npm run build:app</code></p>
          <h3>Available endpoints:</h3>
          <ul>
            <li><a href="/api/observe/cost">/api/observe/cost</a></li>
            <li><a href="/api/observe/cache">/api/observe/cache</a></li>
            <li><a href="/api/observe/sessions">/api/observe/sessions</a></li>
            <li><a href="/api/observe/inferences">/api/observe/inferences</a></li>
            <li><a href="/api/observe/agents">/api/observe/agents</a></li>
          </ul>
        </body></html>
      `);
    });
  }

  const server = createServer(app);
  server.listen(port, host, () => {
    console.log(`🍓 Berry Observe server at http://localhost:${port}`);
    if (existsSync(uiDist)) {
      console.log(`📊 Dashboard: http://localhost:${port}`);
    }
    console.log(`📡 API: http://localhost:${port}/api/observe/*`);
  });

  return server;
}
