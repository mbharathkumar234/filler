import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

/**
 * The content script must be a classic script (§ found in use).
 *
 * ## The bug
 *
 * `chrome.scripting.executeScript({ files })` injects a **classic** script. The
 * main build emitted `dist/content.js` as an ES module — it began
 * `import { … } from "./assets/…"`, because Rollup split shared code into
 * chunks — and a classic script with a top-level `import` is a syntax error.
 *
 * So the file never parsed. Nothing ran, no message listener was registered,
 * and every scan ended with "nothing on this page answered". The content script
 * had never worked in the loaded extension.
 *
 * ## Why nothing caught it
 *
 * The Playwright suite loads the content script with
 * `addScriptTag({ type: 'module' })`. That is a fine way to exercise the
 * *code* — 76 e2e tests do, including the whole submit guard — and no way at
 * all to exercise the *injection*. The one step that only exists in a loaded
 * extension was the one step nothing tested.
 *
 * It is the same shape as the service worker's missing `window`: every test
 * ran the code in a context more permissive than the real one. That is the
 * failure mode worth remembering from all of this — a suite can be large,
 * adversarial, and mutation-tested, and still never put the code where it
 * actually has to run.
 *
 * ## What is asserted
 *
 * Not "does it look right" — the two things that make it unparseable as a
 * classic script, plus the self-containment that keeps it that way.
 */

const BUNDLE = 'dist/content.js';

describe('the built content script', () => {
  it.skipIf(!existsSync(BUNDLE))('has no top-level import', async () => {
    const code = await readFile(BUNDLE, 'utf8');
    const imports = code.split('\n').filter((line) => /^import[\s{'"(]/.test(line));
    expect(imports, 'a classic script cannot parse a top-level import').toEqual([]);
  });

  it.skipIf(!existsSync(BUNDLE))('has no top-level export', async () => {
    const code = await readFile(BUNDLE, 'utf8');
    const exports = code.split('\n').filter((line) => /^export[\s{]/.test(line));
    expect(exports).toEqual([]);
  });

  it.skipIf(!existsSync(BUNDLE))('references no other chunk', async () => {
    // Self-containment is what keeps the two above true. A dependency left
    // outside the bundle is a dependency the injected script cannot fetch.
    const code = await readFile(BUNDLE, 'utf8');
    expect(code).not.toContain('./assets/');
    expect(code).not.toContain('import.meta');
  });

  it.skipIf(!existsSync(BUNDLE))('wraps itself, so nothing leaks into the page', async () => {
    const code = await readFile(BUNDLE, 'utf8');
    expect(code.trimStart().startsWith('var ') || code.trimStart().startsWith('(function')).toBe(true);
  });

  it.skipIf(!existsSync(BUNDLE))('registers a message listener, which is the whole point', async () => {
    // If this ever goes missing the panel reports "nothing answered", which is
    // exactly the symptom that took four rounds to trace.
    const code = await readFile(BUNDLE, 'utf8');
    expect(code).toContain('onMessage');
  });

  it('is checked against a bundle that exists', () => {
    // The checks above skip on a fresh checkout, which is right, and would be
    // silently useless in CI, which is not.
    if (!existsSync(BUNDLE)) {
      expect
        .soft(existsSync(BUNDLE), 'run `npm run build` before trusting the content-script format tests')
        .toBe(true);
    }
    expect(true).toBe(true);
  });
});
