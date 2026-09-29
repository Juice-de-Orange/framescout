import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';

// The daemon serves the built bundle from `/ui` — Vite's `base` makes
// every emitted asset reference resolve relative to that prefix.
export default defineConfig({
  base: '/ui/',
  plugins: [preact()],
  build: {
    outDir: 'dist',
    // Disable hashing for the index.html so the daemon's static-asset
    // middleware can serve the same file in dev and prod.
    rollupOptions: {
      output: {
        entryFileNames: 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
  server: {
    port: 5173,
    // Proxy /api → the daemon during local dev (`pnpm --filter
    // @framescout/ui dev` after `pnpm --filter @framescout/daemon start`).
    proxy: {
      '/api': 'http://127.0.0.1:9090',
    },
  },
});
