import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

import manifestExport from '../../manifest.config';
import pkg from '../../package.json' with { type: 'json' };

/**
 * The Phase F release gates, as tests (§ COMPLETION_PLAN Phase F).
 *
 * Two of that phase's gates — the permission budget and the licence check —
 * are the kind anybody can satisfy once, by hand, on the day they are asked
 * about it, and then quietly lose six commits later. `<all_urls>` appears in
 * the plan's own triage table under "why it hides": *nothing breaks until store
 * review*. A dependency added for one utility function drags in a transitive
 * GPL package and nothing breaks then either.
 *
 * So they are asserted here rather than reported. The point is not that they
 * pass today; it is that a change which breaks one fails the build.
 */

const require = createRequire(import.meta.url);

/**
 * What a manifest has to have for these gates to mean anything.
 *
 * `defineManifest` widens its return to a union that also allows a function or
 * a promise, and does not export the object member. Rather than reach into the
 * plugin's internals, this names the fields the gates read — which doubles as
 * the list of things a reviewer is being promised.
 */
interface GatedManifest {
  permissions?: string[];
  host_permissions?: string[];
  optional_host_permissions?: string[];
  content_scripts?: unknown;
  content_security_policy?: { extension_pages?: string };
}

const manifest = manifestExport as GatedManifest;

describe('the permission budget (§ Phase F)', () => {
  it('asks for exactly the four permissions the plan allows', () => {
    // "activeTab + scripting + storage + sidePanel. No <all_urls>."
    expect([...(manifest.permissions ?? [])].sort()).toEqual([
      'activeTab',
      'scripting',
      'sidePanel',
      'storage',
    ]);
  });

  it('has no standing access to any site', () => {
    expect(manifest.host_permissions ?? []).toEqual([]);
  });

  it('never says <all_urls>, anywhere', () => {
    // Including in `optional_host_permissions`. `*://*/*` is the same reach but
    // not the same grant: it excludes `file://` and every non-web scheme, and
    // nothing under it is granted until the user grants one origin.
    expect(JSON.stringify(manifest)).not.toContain('all_urls');
  });

  it('grants no host at install — the wide pattern is optional only', () => {
    const optional = manifest.optional_host_permissions ?? [];
    expect(optional).toEqual(['*://*/*']);
    expect(manifest.host_permissions ?? []).toHaveLength(0);
  });

  it('declares no content scripts — injection is on user activation', () => {
    // P1: the user is present. A declared content script runs without one.
    expect(manifest.content_scripts).toBeUndefined();
  });

  it('asks for none of the permissions that would make it a surveillance tool', () => {
    const forbidden = ['tabs', 'webRequest', 'webRequestBlocking', 'cookies', 'downloads', 'history', 'management', 'debugger'];
    for (const permission of forbidden) {
      expect(manifest.permissions ?? [], permission).not.toContain(permission);
    }
  });
});

describe('the content security policy (§ Phase F)', () => {
  const csp = manifest.content_security_policy?.extension_pages ?? '';

  it('permits no JavaScript eval and no remote script', () => {
    expect(csp).not.toContain("'unsafe-eval'");
    expect(csp).not.toContain("'unsafe-inline'");
    expect(csp).toContain("script-src 'self'");
  });

  it('permits WASM compilation, and says so on purpose', () => {
    // The one relaxation. `wasm-unsafe-eval` compiles WebAssembly and does not
    // enable `eval` or `new Function`; it is what Argon2id costs.
    expect(csp).toContain("'wasm-unsafe-eval'");
  });

  it('names exactly one network host, so the CSP states the egress boundary', () => {
    const connect = /connect-src ([^;]+)/.exec(csp)?.[1]?.trim().split(/\s+/) ?? [];
    expect(connect).toEqual(["'self'", 'https://api.anthropic.com']);
  });
});

describe('the dependency licences (§ Phase F)', () => {
  /** Permissive: use, modify and redistribute in a closed product, attribution only. */
  const PERMISSIVE = new Set(['MIT', 'ISC', '0BSD', 'BSD-2-Clause', 'BSD-3-Clause', 'Apache-2.0', 'Unlicense', 'CC0-1.0', '(MIT AND Zlib)', 'Zlib']);

  /** The whole runtime closure — direct dependencies and everything they pull. */
  function runtimeClosure(): Map<string, string> {
    const found = new Map<string, string>();
    const visit = (name: string): void => {
      if (found.has(name)) return;
      const path = require.resolve(`${name}/package.json`, { paths: [process.cwd()] });
      const json = require(path) as { license?: string; dependencies?: Record<string, string> };
      found.set(name, json.license ?? 'UNKNOWN');
      for (const child of Object.keys(json.dependencies ?? {})) visit(child);
    };
    for (const name of Object.keys(pkg.dependencies)) visit(name);
    return found;
  }

  it('are all permissive, transitively', () => {
    const offenders: string[] = [];
    for (const [name, license] of runtimeClosure()) {
      if (!PERMISSIVE.has(license)) offenders.push(`${name}: ${license}`);
    }
    expect(offenders).toEqual([]);
  });

  it('records what ships, so a new one is visible in the diff', () => {
    // devDependencies are not shipped and are not listed. This is the closure
    // that ends up in a user's browser.
    expect([...runtimeClosure().keys()].sort()).toMatchSnapshot();
  });

  it('ships no dependency that can reach the network on its own', () => {
    // None of these fetch. If one appears that does, the egress boundary in
    // `redaction.ts` stops being the only way out and this needs re-reasoning.
    expect(Object.keys(pkg.dependencies).sort()).toEqual([
      'hash-wasm',
      'idb',
      'pdf-lib',
      'pdfjs-dist',
      'react',
      'react-dom',
    ]);
  });
});
