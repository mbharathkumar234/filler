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

/**
 * Make Vite's dynamic-import helper survive a service worker.
 *
 * `__vitePreload` ends with `window.dispatchEvent(e)` in its error handler. In
 * an MV3 service worker there is no `window`, so **every** dynamic-import
 * failure — whatever actually went wrong — was replaced by
 * `window is not defined` before it reached anyone. That masking is what made
 * the vault-creation bug so hard to find: the real error never surfaced.
 *
 * `globalThis.dispatchEvent?.()` is the same call in a page (where
 * `window === globalThis`) and a no-op in a worker. With no listener attached,
 * `defaultPrevented` stays false and the helper rethrows the **original**
 * error, which is the behaviour that was wanted all along.
 *
 * `modulePreload: false` already empties every dependency array, so the
 * helper's other DOM branch — the one that writes to `document.head` — is dead
 * code. Between the two, nothing the worker can reach touches the DOM.
 */
function workerSafePreload() {
  const NEEDLE = 'window.dispatchEvent(e);';
  return {
    name: 'autofill:worker-safe-preload',
    generateBundle(_options: unknown, bundle: Record<string, { type: string; code?: string }>) {
      for (const chunk of Object.values(bundle)) {
        if (chunk.type !== 'chunk' || !chunk.code?.includes(NEEDLE)) continue;
        chunk.code = chunk.code.replaceAll(NEEDLE, 'globalThis.dispatchEvent?.(e);');
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwind(), crx({ manifest }), practiceForm(), workerSafePreload()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  build: {
    target: 'es2022',
    /*
     * No module-preload helper.
     *
     * Vite wraps every dynamic `import()` in `__vitePreload`, which injects
     * `<link rel="modulepreload">` tags into `document.head` and reports
     * failures with `window.dispatchEvent`. Both are meaningless in an
     * extension — there is no document to preload into — and in the **service
     * worker** neither global exists at all.
     *
     * The result was a real, shipped bug: `crypto.ts` dynamically imports
     * `hash-wasm` for Argon2id, so creating a vault ran the helper, and any
     * failure inside it surfaced to the user as `window is not defined`. Worse
     * than the crash was the masking — `baseModule().catch(handlePreloadError)`
     * rewrites *every* dynamic-import error into that same sentence, so the
     * actual cause never reached anyone.
     *
     * Turning the helper off leaves bare `import()`, which is what a service
     * worker can actually run, and lets real errors say what they are.
     * `worker-bundle.test.ts` asserts the worker bundle stays free of both
     * globals.
     */
    modulePreload: false,
    // No remote code, no eval — Phase 10 hardening depends on this staying true.
    minify: false,
    sourcemap: true,
    /*
     * The content script is **not** built here.
     *
     * It is injected programmatically with `chrome.scripting.executeScript`,
     * which runs a *classic* script — and as an entry in this build Rollup
     * emitted it as an ES module importing shared chunks, which a classic
     * script cannot parse. It has its own build instead:
     * `vite.content.config.ts`, `lib` mode, `iife`, self-contained.
     */
    rollupOptions: {
      output: {
        entryFileNames: 'assets/[name]-[hash].js',
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
