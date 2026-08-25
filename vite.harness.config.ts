/**
 * Builds the e2e derivation harness (tests/e2e/harness) into fixtures/_harness
 * so the fixtures server can serve it to Playwright. Test-only; never part of
 * the extension build.
 */
import { defineConfig } from 'vite';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  root: fileURLToPath(new URL('./tests/e2e/harness', import.meta.url)),
  // Relative base: the harness is served from /_harness/, not the server root.
  base: './',
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  build: {
    outDir: fileURLToPath(new URL('./fixtures/_harness', import.meta.url)),
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: false,
  },
  logLevel: 'warn',
});
