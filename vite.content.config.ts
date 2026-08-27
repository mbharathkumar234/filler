import { defineConfig } from 'vite';
import { fileURLToPath, URL } from 'node:url';

/**
 * Builds the content script as a **classic, self-contained script**.
 *
 * ## Why this is a separate build
 *
 * `chrome.scripting.executeScript({ files })` injects a *classic* script. The
 * main build emitted `content.js` as an ES module — it began
 * `import { … } from "./assets/…"` because Rollup had split shared code into
 * chunks — and a classic script containing a top-level `import` is a syntax
 * error. It never parsed, so nothing ran, no message listener was registered,
 * and every scan ended with "nothing on this page answered".
 *
 * The content script has therefore never worked in the loaded extension. It was
 * invisible because the Playwright harness loads it with
 * `addScriptTag({ type: 'module' })`, which is a perfectly good way to exercise
 * the *code* and no way at all to exercise the *injection*. The one execution
 * path that only exists in a real browser was the one nothing tested — the same
 * blind spot that hid the service worker's missing `window`.
 *
 * `lib` mode with the `iife` format inlines every dependency into one file with
 * no imports and no exports, which is exactly what an injected script has to
 * be. `emptyOutDir: false` because this runs after the main build and must not
 * delete it.
 *
 * `content-script-format.test.ts` asserts the output stays a classic script.
 */
export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  build: {
    target: 'es2022',
    // Same reasoning as the main build: no eval, and readable in review.
    minify: false,
    sourcemap: true,
    outDir: 'dist',
    emptyOutDir: false,
    lib: {
      entry: fileURLToPath(new URL('./src/content/index.ts', import.meta.url)),
      formats: ['iife'],
      // The wrapper needs a name; nothing reads it. The script wires itself
      // through listeners rather than exposing an API to the page.
      name: '__autofillContentScript',
      fileName: () => 'content.js',
    },
  },
});
