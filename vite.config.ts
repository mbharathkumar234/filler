import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { crx } from '@crxjs/vite-plugin';
import { fileURLToPath, URL } from 'node:url';
import { readFileSync } from 'node:fs';
import manifest from './manifest.config.ts';

/**
 * Ship the practice form inside the extension (§ Phase F onboarding).
 *
 * It lives in `fixtures/` because that is where the fixture-corpus test and
 * the e2e server both look for it, and one copy that both the product and the
 * tests use is the only version that cannot drift. This emits that same file
 * into the bundle so `chrome.runtime.getURL('practice/first-fill.html')`
 * resolves — a first run must not depend on a dev server being up.
 */
function practiceForm() {
  const source = fileURLToPath(new URL('./fixtures/practice/first-fill.html', import.meta.url));
  return {
    name: 'autofill:practice-form',
    generateBundle(this: { emitFile: (f: { type: 'asset'; fileName: string; source: string }) => void }) {
      this.emitFile({
        type: 'asset',
        fileName: 'practice/first-fill.html',
        source: readFileSync(source, 'utf8'),
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwind(), crx({ manifest }), practiceForm()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  build: {
    target: 'es2022',
    // No remote code, no eval — Phase 10 hardening depends on this staying true.
    minify: false,
    sourcemap: true,
    rollupOptions: {
      input: {
        // The content script is injected programmatically on a user gesture,
        // so it is NOT declared in the manifest (a declared content script
        // auto-injects everywhere, which is what §Phase 3 forbids). It still
        // needs to be built, hence an explicit entry with a fixed filename
        // that harvest-service.ts can hand to chrome.scripting.
        content: 'src/content/index.ts',
      },
      output: {
        entryFileNames: (chunk) =>
          chunk.name === 'content' ? 'content.js' : 'assets/[name]-[hash].js',
      },
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    // Phase 0 ships one taxonomy invariant test; every later phase adds more.
    passWithNoTests: true,
  },
});
