import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { crx } from '@crxjs/vite-plugin';
import { fileURLToPath, URL } from 'node:url';
import manifest from './manifest.config.ts';

export default defineConfig({
  plugins: [react(), tailwind(), crx({ manifest })],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  build: {
    target: 'es2022',
    // No remote code, no eval — Phase 10 hardening depends on this staying true.
    minify: false,
    sourcemap: true,
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    // Phase 0 ships one taxonomy invariant test; every later phase adds more.
    passWithNoTests: true,
  },
});
