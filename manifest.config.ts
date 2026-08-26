import { defineManifest } from '@crxjs/vite-plugin';
import pkg from './package.json' with { type: 'json' };

/**
 * Permission budget is deliberately small (P1, P6, and the Phase 10 store-review
 * risk in §6.4). Rules:
 *   - `activeTab` + explicit user click, never `<all_urls>` auto-injection.
 *   - Host permissions are added per shipped site profile, one entry each.
 *   - No `tabs`, no `webRequest`, no `cookies`, no `downloads`.
 */
export default defineManifest({
  manifest_version: 3,
  name: 'AutoFill Assistant',
  version: pkg.version.replace(/^0\.0\.0$/, '0.0.1'),
  description: pkg.description,
  minimum_chrome_version: '116',

  permissions: ['activeTab', 'storage', 'sidePanel', 'scripting'],
  host_permissions: [],

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
     * any WASM in an extension page, and the WASM in question is the Argon2id
     * implementation, bundled as base64 inside our own JavaScript rather than
     * fetched. So: no remote code, no JS eval, and a memory-hard KDF. The
     * alternative was PBKDF2 forever, which is the weaker trade.
     */
    extension_pages:
      "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'; connect-src 'self' https://api.anthropic.com",
  },
});
