import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';

// The studio's Python server serves the built bundle from the package's
// `web/` dir at the site root, so `base: '/'`. We build *into* the Python
// package (not a `dist/` subdir — the repo's root .gitignore excludes any
// `dist/`, and a built bundle that ships in the wheel must be committed)
// and the package's `web/**/*` data-glob picks it up.
export default defineConfig({
  base: '/',
  plugins: [preact()],
  build: {
    outDir: '../framescout_studio/web',
    // outDir is outside this project root, so Vite needs explicit consent
    // to clear it before each build.
    emptyOutDir: true,
    rollupOptions: {
      output: {
        entryFileNames: 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
  server: {
    port: 5174,
    // Proxy /api → the local studio server during `npm run dev`
    // (start it first with `python -m framescout_studio`).
    proxy: {
      '/api': 'http://127.0.0.1:8770',
    },
  },
});
