import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { vitePluginForArco } from '@arco-plugins/vite-react';
import { resolve } from 'node:path';

// Output to ../dist/ui so the server-side handler can require/read it
// from a predictable path inside the published a8s-server package.
export default defineConfig({
  plugins: [
    react(),
    // On-demand import: only the CSS for components actually used is injected,
    // keeping the shipped bundle lean (the box can't build — we ship dist).
    // style:'css' avoids pulling a Less toolchain into the local build.
    vitePluginForArco({ style: 'css' }),
  ],
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
