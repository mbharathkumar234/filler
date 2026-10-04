import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
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
  it('asks for exactly the permissions the plan allows, and one it argued for', () => {
    /*
     * "activeTab + scripting + storage + sidePanel. No <all_urls>."
     *
     * `offscreen` was added for the document reader. An offscreen document is
     * the only place in an extension that can start a Web Worker, which is what
     * recognising text needs; it has no UI, no tab and no access to any site,
     * and `ocr-host.ts` closes it as soon as a reading finishes. It grants
     * nothing about the user's browsing — which is the test this list exists
     * to keep applying to every future addition.
     */
    expect([...(manifest.permissions ?? [])].sort()).toEqual([
      'activeTab',
      'offscreen',
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

  /**
   * A package's own manifest, read off disk.
   *
   * Not `require.resolve`: a package may forbid `./package.json` in its
   * `exports`, and one in this tree does — which threw and took the whole
   * licence gate down with it. Resolution is done the way Node does it, by
   * walking `node_modules` upwards from the package that asked, so a nested
   * copy is read as the nested copy rather than as whatever npm hoisted.
   */
  function manifestOf(
    name: string,
    from: string,
  ): { dir: string; license?: string; dependencies?: Record<string, string> } | null {
    let dir = from;
    for (;;) {
      const home = join(dir, 'node_modules', ...name.split('/'));
      const file = join(home, 'package.json');
      if (existsSync(file)) {
        return { dir: home, ...(JSON.parse(readFileSync(file, 'utf8')) as object) };
      }
      const parent = dirname(dir);
      if (parent === dir) return null;
      dir = parent;
    }
  }

  /** The whole runtime closure — direct dependencies and everything they pull. */
  function runtimeClosure(): Map<string, string> {
    const found = new Map<string, string>();
    const visit = (name: string, from: string): void => {
      if (found.has(name)) return;
      const json = manifestOf(name, from);
      if (json === null) {
        // An optional dependency that was not installed cannot ship either.
        return;
      }
      found.set(name, json.license ?? 'UNKNOWN');
      for (const child of Object.keys(json.dependencies ?? {})) visit(child, json.dir);
    };
    for (const name of Object.keys(pkg.dependencies)) visit(name, process.cwd());
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

  it('ships these dependencies, and no others', () => {
    /*
     * None of these reaches the network by itself. `onnxruntime-web` runs the
     * document reader's models and could be pointed at a CDN for its
     * WebAssembly; the CPU build this package imports carries its WebAssembly
     * as a build asset instead, and the next test holds that in place.
     *
     * PaddleOCR's two models are not npm packages and are not listed here:
     * `scripts/fetch-ocr-models.mjs` fetches them **at build time** from
     * PaddleOCR's model host, pinned by SHA-256, and the build copies them in.
     * PaddleOCR's own browser SDK is deliberately absent — its OpenCV.js needs
     * `new Function`, which the extension's CSP forbids.
     */
    expect(Object.keys(pkg.dependencies).sort()).toEqual([
      'hash-wasm',
      'idb',
      'onnxruntime-web',
      'pdfjs-dist',
      'react',
      'react-dom',
    ]);
  });

  it('points the document reader at this package, never at a CDN', () => {
    const page = readFileSync('src/offscreen/ocr.ts', 'utf8');
    const worker = readFileSync('src/offscreen/reader-worker.ts', 'utf8');

    // The CPU build of the runtime, whose WebAssembly the bundler emits into
    // this package; the default entry would pull in the WebGPU build too.
    expect(worker).toContain("from 'onnxruntime-web/wasm'");
    // Nothing tells the runtime to look for its WebAssembly anywhere else.
    expect(worker).not.toMatch(/wasmPaths/);
    // The worker fetches its models from one base, and that base is the
    // extension's own folder, named by the page that started it.
    for (const fetchCall of worker.match(/fetch\([^)]*\)/g) ?? []) {
      expect(fetchCall).toMatch(/^fetch\(`\$\{base\}/);
    }
    expect(page).toContain("base: chrome.runtime.getURL('ocr/')");
    // The worker is started from the package by URL, never from a blob.
    expect(page).toContain("new Worker(new URL('./reader-worker.ts', import.meta.url)");
    for (const source of [page, worker]) expect(source).not.toMatch(/https?:\/\//);
  });

  it('builds with the models it was measured with, and no others', () => {
    // Pinned by hash, so a changed file on the model host fails the build
    // rather than quietly changing what reads the user's documents. Each was
    // measured in the real reader: the first three on the user's own documents
    // (Phase 0), the other scripts' recognisers on made-up lines
    // (`e2e/ocr.spec.ts` → "reads Hindi, Telugu and Tamil…"), UVDoc and the
    // line classifier on a made-up curled photo and turned lines
    // (`e2e/ocr.spec.ts` → "flattens a photo of a curled page…"), SLANet_plus
    // on made-up grade cards, ruled and open (`e2e/ocr.spec.ts` → "reads a
    // grade card's courses…").
    const fetcher = readFileSync('scripts/fetch-ocr-models.mjs', 'utf8');
    const reader = readFileSync('src/offscreen/reader-worker.ts', 'utf8');
    const pinned = [...fetcher.matchAll(/name: '([^']+)',\s*sha256: '([0-9a-f]{64})'/g)];
    expect(pinned.map((m) => m[1]).sort()).toEqual([
      'PP-LCNet_x0_25_textline_ori',
      'PP-LCNet_x1_0_doc_ori',
      'PP-OCRv5_mobile_det',
      'SLANet_plus',
      'UVDoc',
      'devanagari_PP-OCRv5_mobile_rec',
      'en_PP-OCRv5_mobile_rec',
      'ta_PP-OCRv5_mobile_rec',
      'te_PP-OCRv5_mobile_rec',
    ]);
    for (const [, name] of pinned) expect(reader).toContain(`'${name}'`);
  });

  it('never ships PaddleOCR’s browser SDK, which the CSP would refuse', () => {
    const all = { ...pkg.dependencies, ...(pkg.devDependencies ?? {}) };
    expect(Object.keys(all)).not.toContain('@paddleocr/paddleocr-js');
    expect(Object.keys(all)).not.toContain('@techstark/opencv-js');
  });
});

describe('RBI’s and India Post’s lists (§ checking a code)', () => {
  /*
   * An IFSC or a PIN — typed, or read off a passbook — is looked up in files
   * shipped inside the extension. No server is asked, so the code goes nowhere;
   * and the files are pinned, so a changed list fails the build rather than
   * quietly changing what the extension says about somebody's branch.
   */
  it('are fetched when the extension is built, pinned by hash, each crediting its source and licence', () => {
    const fetcher = readFileSync('scripts/fetch-reference-data.mjs', 'utf8');
    const pinned = [...fetcher.matchAll(/name: '([^']+)',[\s\S]*?url: '(https:\/\/[^']+)',\s*sha256: '([0-9a-f]{64})'/g)];
    expect(pinned.map((m) => m[1])).toEqual(['ifsc', 'pincode']);
    expect(fetcher).toContain('razorpay/ifsc v2.0.62 (MIT)');
    // GODL-India allows reuse with credit, so the credit is part of the pin.
    expect(fetcher).toContain('Department of Posts, Government of India, data.gov.in (Government Open Data License – India)');
  });

  it('are read from this package, never from a server', () => {
    const lookup = readFileSync('src/background/reference-data.ts', 'utf8');
    expect(lookup.match(/fetch\([^)]*\)/g)).toEqual(['fetch(chrome.runtime.getURL(`reference/${path}`)']);
    for (const file of [
      'src/background/reference-data.ts',
      'src/reference/ifsc.ts',
      'src/reference/pincode.ts',
      'src/reference/places.ts',
      'src/documents/reference-check.ts',
      'src/ui/lib/reference-offer.ts',
    ]) {
      expect(readFileSync(file, 'utf8'), file).not.toMatch(/https?:\/\//);
    }
  });
});

describe('the reader’s threads (§ reading a document)', () => {
  /*
   * More than one thread needs memory shared between workers, which a browser
   * allows only on a page isolated from other origins. For an extension that is
   * two manifest keys, and they isolate **every** page of the extension — which
   * costs nothing here, because no page of it loads anything from another
   * origin, and is a hardening besides.
   */
  const reader = readFileSync('src/offscreen/reader-worker.ts', 'utf8');

  it('isolates the extension’s pages, which is what lets memory be shared', () => {
    const keys = manifest as unknown as Record<string, { value?: string } | undefined>;
    expect(keys.cross_origin_embedder_policy?.value).toBe('require-corp');
    expect(keys.cross_origin_opener_policy?.value).toBe('same-origin');
  });

  it('loads the runtime as a file of its own', () => {
    // Each thread is started by loading the file ONNX Runtime lives in. Were
    // that file the reader itself, every thread would start a reader.
    expect(reader).toContain("import('onnxruntime-web/wasm')");
    expect(reader).not.toMatch(/^import \* as ort from 'onnxruntime-web\/wasm';/m);
  });

  it('is listening before it loads anything', () => {
    // A worker that awaits at its top level has not yet said `onmessage`, and
    // the reading that started it is posted to nobody.
    expect(reader).not.toMatch(/^(?:const|let) \w+ = await /m);
  });

  it('decides the thread count from whether the page really is isolated', () => {
    expect(reader).toContain('readerThreads(self.crossOriginIsolated');
    expect(reader).not.toMatch(/numThreads = \d/);
  });
});
