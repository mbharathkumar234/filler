import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { crx } from '@crxjs/vite-plugin';
import { fileURLToPath, URL } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { OCR_MODELS, archivePath } from './scripts/fetch-ocr-models.mjs';
import { modelConfigFrom } from './src/documents/paddle.ts';
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
 * Put the document reader's models in the package (§ reading a document).
 *
 * PaddleOCR's text detector and English recogniser, from the archives
 * `scripts/fetch-ocr-models.mjs` pinned by SHA-256 into `vendor/ocr-models/`.
 * Each archive holds an `inference.onnx` and an `inference.yml`; the model goes
 * in as it is, and the settings go in as **JSON**, parsed here by a real YAML
 * parser. The recogniser's character list alone has hundreds of entries in
 * every quoting style YAML allows, and one entry misread makes every character
 * after it read as its neighbour — so it is parsed once, at build time, by a
 * parser that gets it right, and the extension carries no YAML parser at all.
 *
 * ONNX Runtime's WebAssembly needs no copying: the runtime refers to it with
 * `new URL(..., import.meta.url)`, which Vite emits as an asset of this package.
 * `verify-dist.mjs` fails the build if any of it did not arrive.
 */
function ocrAssets() {
  /** The two files wanted from a PaddleX model archive (uncompressed ustar). */
  function unpack(tar: Buffer): { onnx: Buffer; yml: string } {
    const found: Record<string, Buffer> = {};
    let longName: string | null = null;
    for (let at = 0; at + 512 <= tar.length; ) {
      const header = tar.subarray(at, at + 512);
      if (header.every((byte) => byte === 0)) break;
      const field = (from: number, length: number) =>
        header.subarray(from, from + length).toString('utf8').replace(/\0.*$/s, '');
      const size = parseInt(field(124, 12).trim() || '0', 8);
      const type = field(156, 1);
      const prefix = field(345, 155);
      const body = tar.subarray(at + 512, at + 512 + size);
      const name = longName ?? (prefix ? `${prefix}/${field(0, 100)}` : field(0, 100));
      longName = null;

      if (type === 'L') longName = body.toString('utf8').replace(/\0.*$/s, '');
      else if (type === '0' || type === '') found[name.split('/').pop()!] = Buffer.from(body);

      at += 512 + Math.ceil(size / 512) * 512;
    }
    const onnx = found['inference.onnx'];
    const yml = found['inference.yml'];
    if (!onnx || !yml) throw new Error('A model archive is missing inference.onnx or inference.yml.');
    return { onnx, yml: yml.toString('utf8') };
  }

  return {
    name: 'autofill:ocr-assets',
    generateBundle(this: {
      emitFile: (f: { type: 'asset'; fileName: string; source: Uint8Array | string }) => void;
    }) {
      for (const model of OCR_MODELS) {
        const path = archivePath(model.name);
        if (!existsSync(path)) {
          throw new Error(
            `${model.name} is missing from vendor/ocr-models. Run \`npm run ocr:models\`; ` +
              'without it the extension ships a document reader that cannot read.',
          );
        }
        const { onnx, yml } = unpack(readFileSync(path));
        const config = modelConfigFrom(parseYaml(yml));
        if (config.modelName !== model.name) {
          throw new Error(`${path} declares model ${config.modelName}, not ${model.name}.`);
        }
        this.emitFile({ type: 'asset', fileName: `ocr/${model.name}.onnx`, source: onnx });
        this.emitFile({ type: 'asset', fileName: `ocr/${model.name}.json`, source: JSON.stringify(config) });
      }
    },
  };
}

/**
 * pdf.js's decoders for the images scanners write, copied into `pdfjs/`.
 *
 * A black-and-white scan is usually stored as CCITT fax or JBIG2, both decoded
 * by `jbig2.wasm`; JPEG 2000 by `openjpeg.wasm`; embedded colour profiles by
 * `qcms_bg.wasm`. pdf.js fetches them from the `wasmUrl` it is given
 * (`documents/pdfjs.ts` → `openPdf`), and without them draws such an image as
 * nothing: a scanned page read as blank. They are pdf.js's own files, from the
 * same pinned package, so they are copied as they are — the JavaScript
 * fallbacks beside them are not, since nothing here may load script that way.
 */
const PDFJS_DECODERS = ['jbig2.wasm', 'openjpeg.wasm', 'qcms_bg.wasm'] as const;

function pdfjsDecoders() {
  return {
    name: 'autofill:pdfjs-decoders',
    generateBundle(this: {
      emitFile: (f: { type: 'asset'; fileName: string; source: Uint8Array | string }) => void;
    }) {
      for (const name of PDFJS_DECODERS) {
        const path = fileURLToPath(new URL(`./node_modules/pdfjs-dist/wasm/${name}`, import.meta.url));
        this.emitFile({ type: 'asset', fileName: `pdfjs/${name}`, source: readFileSync(path) });
      }
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

/**
 * Build the content script as part of this build, not beside it.
 *
 * It needs its own Vite config — `executeScript` injects a *classic* script,
 * and only `lib`/`iife` produces one — but making that a second command in
 * `package.json` made it skippable, and it got skipped. The result was a `dist`
 * with no `content.js` at all, which Chrome reports as
 * "Could not load file: 'content.js'" and which looks from the panel like yet
 * another mysterious scan failure.
 *
 * Running it from `closeBundle` means any `vite build` produces a complete
 * extension. The existence check afterwards is the point: a missing content
 * script must fail the build loudly, not ship quietly.
 */
function buildContentScript() {
  return {
    name: 'autofill:build-content-script',
    apply: 'build' as const,
    async closeBundle() {
      const { build } = await import('vite');
      await build({ configFile: fileURLToPath(new URL('./vite.content.config.ts', import.meta.url)) });

      const output = fileURLToPath(new URL('./dist/content.js', import.meta.url));
      if (!existsSync(output)) {
        throw new Error(
          'dist/content.js was not produced. The extension cannot read any page without it.',
        );
      }
    },
  };
}

export default defineConfig({
  /*
   * The document reader's worker is an ES module: ONNX Runtime finds its own
   * WebAssembly with `new URL(..., import.meta.url)`, which only means
   * something in a module, and Vite then emits that file into the package.
   */
  worker: { format: 'es' },
  plugins: [
    react(),
    tailwind(),
    crx({ manifest }),
    practiceForm(),
    ocrAssets(),
    pdfjsDecoders(),
    workerSafePreload(),
    buildContentScript(),
  ],
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
      /*
       * The offscreen reader page. It is not in the manifest — an offscreen
       * document is opened by URL at runtime — so it has to be named here or
       * Rollup never builds it.
       */
      input: {
        ocr: fileURLToPath(new URL('./src/offscreen/ocr.html', import.meta.url)),
      },
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
