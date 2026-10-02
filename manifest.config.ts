import { defineManifest } from '@crxjs/vite-plugin';
import pkg from './package.json' with { type: 'json' };

/**
 * Permission budget is deliberately small (P1, P6, and the Phase 10 store-review
 * risk in §6.4). Rules:
 *   - `activeTab` + explicit user click, never `<all_urls>` auto-injection.
 *   - Host permissions are added per shipped site profile, one entry each.
 *   - No `tabs`, no `webRequest`, no `cookies`, no `downloads`.
 */
/**
 * The two keys that isolate the extension's pages (see where they are used).
 *
 * Spread in rather than written in place because the bundler plugin's manifest
 * type does not know them yet; Chrome has since 93, and `verify-dist.mjs`
 * checks they reach the manifest that is built.
 */
const CROSS_ORIGIN_ISOLATION = {
  cross_origin_embedder_policy: { value: 'require-corp' },
  cross_origin_opener_policy: { value: 'same-origin' },
};

export default defineManifest({
  manifest_version: 3,
  name: 'AutoFill Assistant',
  version: pkg.version.replace(/^0\.0\.0$/, '0.0.1'),
  description: pkg.description,
  minimum_chrome_version: '116',

  /*
   * `offscreen` is the newest of these and the least obvious. The document
   * reader — PaddleOCR's models on ONNX Runtime — runs in a dedicated Web
   * Worker, and an offscreen document is the only place in an extension that
   * can start one (a service worker cannot). It has no UI, no tab and no access
   * to any site, and it is closed as soon as the last reading finishes, ending
   * the worker with it — see `background/ocr-host.ts`.
   */
  permissions: ['activeTab', 'storage', 'sidePanel', 'scripting', 'offscreen'],

  /**
   * Still empty, and it stays empty. The extension has no standing access to
   * any site.
   */
  host_permissions: [],

  /*
   * Optional, and granted one origin at a time by the user (§ Phase B).
   *
   * A gesture-injected content script cannot run at `document_start`, and the
   * post-fill reload window is a real P2 hole because of it: an ASP.NET
   * postback returns the page carrying values the extension filled, and a
   * portal that submits during `load` sends them before we can exist.
   * `tests/e2e/guard-adversarial.spec.ts` demonstrates it.
   *
   * Closing that needs host permission for the site. Listing it here as
   * *optional* means nothing is granted at install: the user is asked, per
   * portal, at the moment they run a fill on it, and can revoke it from the
   * panel. The alternative — a standing `<all_urls>` — is what Phase F
   * forbids, and rightly.
   */
  optional_host_permissions: ['*://*/*'],

  background: {
    service_worker: 'src/background/index.ts',
    type: 'module',
  },

  side_panel: {
    default_path: 'src/ui/sidepanel/index.html',
  },

  action: {
    default_title: 'AutoFill Assistant',
  },

  // Content scripts are injected programmatically on user activation (Phase 3).
  // Nothing is declared here on purpose.

  /*
   * Every page of the extension is cross-origin isolated.
   *
   * The document reader runs its models on several CPU threads, threads share
   * memory, and a browser lets a page share memory (`SharedArrayBuffer`) only
   * when it is isolated from other origins. These two keys are how an extension
   * asks for that. Measured on the user's own five documents, four threads read
   * them in under half the time of one.
   *
   * They apply to the whole extension, not just the reader's page, and that is
   * acceptable because it costs these pages nothing: none of them embeds a
   * resource, a frame or a window from another origin — the CSP below already
   * forbids the first — and the one network call the extension makes is an
   * ordinary CORS request, which isolation does not touch. It grants no
   * permission and reaches no site; it only narrows what these pages may load.
   */
  ...CROSS_ORIGIN_ISOLATION,

  content_security_policy: {
    /*
     * `connect-src` names the one host this extension talks to, so the CSP is
     * itself a statement of the egress boundary: a reviewer can read the
     * manifest and see there is exactly one. 'self' covers the extension's own
     * bundled assets.
     *
     * `wasm-unsafe-eval` is the one relaxation, and it is worth naming plainly
     * because the plan asks for both "no eval" and "Argon2id (WASM)" and those
     * pull against each other. It permits **WebAssembly compilation only** —
     * not `eval`, not `new Function`, not remote script. Chrome requires it for
     * any WASM in an extension page, and there are two, both inside the
     * package: the Argon2id implementation, bundled as base64 inside our own
     * JavaScript, and ONNX Runtime, which runs the document reader's models and
     * is a build asset. So: no remote code, no JS eval, and a memory-hard KDF.
     * The alternative was PBKDF2 forever, which is the weaker trade.
     *
     * Its absence of `unsafe-eval` is also why PaddleOCR's own browser SDK is
     * not used: its OpenCV.js builds functions with `new Function`. The reader
     * runs PaddleOCR's models on ONNX Runtime directly instead.
     */
    extension_pages:
      "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'; connect-src 'self' https://api.anthropic.com",
  },
});
