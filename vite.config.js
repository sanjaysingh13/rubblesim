import { defineConfig } from 'vite';

// Rapier's WASM init uses top-level await; target a modern baseline that supports it.
export default defineConfig({
  base: './',
  build: { target: 'esnext' },
  esbuild: { target: 'esnext' },
  optimizeDeps: { esbuildOptions: { target: 'esnext' } },
});
