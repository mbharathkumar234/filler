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
    extension_pages: "script-src 'self'; object-src 'self'",
  },
});
