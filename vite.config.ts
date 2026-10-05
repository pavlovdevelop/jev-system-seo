import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';

// The SPA lives in src/web; the API server (Hono) runs separately in dev and serves dist/web in production.
export default defineConfig({
  root: 'src/web',
  plugins: [preact()],
  build: {
    outDir: '../../dist/web',
    emptyOutDir: true,
    sourcemap: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:8787',
    },
  },
});
