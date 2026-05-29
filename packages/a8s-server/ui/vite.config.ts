import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

// Output to ../dist/ui so the server-side handler can require/read it
// from a predictable path inside the published a8s-server package.
export default defineConfig({
  plugins: [react()],
  base: '/ui/',
  build: {
    outDir: resolve(__dirname, '../dist/ui'),
    emptyOutDir: true,
    sourcemap: true,
  },
  server: {
    proxy: {
      '/v1': {
        target: process.env.VITE_A8S_URL ?? 'http://localhost:28789',
        changeOrigin: true,
      },
      '/metrics': {
        target: process.env.VITE_A8S_URL ?? 'http://localhost:28789',
        changeOrigin: true,
      },
    },
  },
});
