import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Two build modes:
// - `npm run build:lib`  → component library (for embedding in other React apps)
// - `npm run build:app`  → standalone app (served by observe server)
// - `npm run dev`        → standalone dev server

const isLib = process.env.BUILD_MODE === 'lib';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: isLib
    ? {
        lib: {
          entry: 'src/index.ts',
          formats: ['es'],
          fileName: 'observe-ui',
        },
        rollupOptions: {
          external: ['react', 'react-dom', 'react/jsx-runtime'],
        },
        outDir: 'dist',
      }
    : {
        outDir: 'dist-app',
        emptyOutDir: true,
      },
  server: {
    proxy: {
      '/api/observe': {
        target: 'http://localhost:3210',
        changeOrigin: true,
      },
    },
  },
});
