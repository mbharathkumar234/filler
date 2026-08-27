import { existsSync, readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

/**
 * The service worker has no DOM (§ found in production).
 *
 * ## The bug this exists to prevent happening again
 *
 * Creating a vault failed with `window is not defined`, and the message was a
 * lie in two directions at once.
 *
 * `crypto.ts` used `await import('hash-wasm')` to keep Argon2id out of every
 * code path that never opens a vault. Vite compiles every dynamic import into
 * a `__vitePreload` wrapper, and that wrapper does two things a service worker
 * cannot survive: it injects `<link rel="modulepreload">` into `document.head`,
 * and it reports any failure with `window.dispatchEvent`. Neither global exists
 * in a worker.
 *
 * The masking was the worse half. The wrapper ends with
 * `baseModule().catch(handlePreloadError)`, so **every** dynamic-import failure
 * — whatever the real cause — was rewritten into that same sentence before it
 * reached the user. The actual error never surfaced anywhere.
 *
 * Nothing caught it. Unit tests run in Node and jsdom, where dynamic import
 * works and both globals exist; the Playwright suite drives a harness *page*,
 * which also has them. There was no test anywhere that looked at the worker
 * bundle as a worker.
 *
 * ## What is asserted, and why it is these two things
 *
 * The fix had two parts, and each has a test here:
 *
 *  1. **`build.modulePreload: false`** empties every dependency array, which
 *     makes the `document.head` branch dead code. Asserted by checking that no
 *     preload call carries dependencies — if one ever does, that branch comes
 *     back to life inside the worker.
 *  2. **No dynamic import on the vault path.** `vault/` and `background/` are
 *     the worker's own code and must not depend on the wrapper at all.
 *
 * `documents/` still imports pdf.js and pdf-lib dynamically, deliberately:
 * statically bundling them drags ~1.6 MB *and* two hundred real `document.`
 * references into the worker, which is worse than the problem. With empty
 * dependency arrays those imports no longer touch the DOM — but if one fails,
 * its error is still masked. That is recorded in STATUS.md rather than papered
 * over.
 */

const ASSETS = 'dist/assets';

function workerChunk(): string | null {
  if (!existsSync(ASSETS)) return null;
  const name = readdirSync(ASSETS).find((f) => f.startsWith('index.ts-') && f.endsWith('.js'));
  return name ? `${ASSETS}/${name}` : null;
}

describe('the built worker bundle', () => {
  it.skipIf(workerChunk() === null)('asks to preload nothing, so the document branch is dead', async () => {
    const bundle = await readFile(workerChunk()!, 'utf8');

    // `__vitePreload(fn, deps)` — the second argument must always be `[]`.
    const withDeps = [...bundle.matchAll(/__vitePreload\([\s\S]*?\},\s*(\[[^\]]*\])\)/g)]
      .map((match) => match[1]!)
      .filter((deps) => deps.replace(/\s/g, '') !== '[]');

    expect(withDeps, 'a preload call carries deps and will reach for document.head').toEqual([]);
  });

  it.skipIf(workerChunk() === null)('reads no `window` property on any reachable line', async () => {
    /*
     * The last one was `window.dispatchEvent` inside `__vitePreload`'s error
     * handler, and it is the reason a dynamic-import failure surfaced as
     * `window is not defined` instead of saying what went wrong. A build
     * plugin rewrites it to `globalThis.dispatchEvent?.()`.
     *
     * Comments are stripped first: this file and `crypto.ts` both *discuss*
     * `window.dispatchEvent`, and a check that forbids naming the bug makes
     * the bug harder to explain.
     */
    const code = (await readFile(workerChunk()!, 'utf8'))
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|\s)\/\/[^\n]*/g, '$1');

    // `window` is also a local variable name in `constraints.ts` and
    // `derive.ts` — a byte-size window. Those three properties are its.
    const offenders = [...code.matchAll(/(?<![.\w$])window\s*\.\s*(\w+)/g)]
      .map((match) => match[1]!)
      .filter((prop) => !['maxBytes', 'minBytes', 'notes'].includes(prop));

    expect(offenders, 'the worker bundle reads a DOM global').toEqual([]);
  });

  it.skipIf(workerChunk() === null)('never maps dependencies at all', async () => {
    // `__vite__mapDeps` only exists when something is being preloaded. Its
    // presence means `modulePreload: false` has stopped taking effect.
    const bundle = await readFile(workerChunk()!, 'utf8');
    expect(bundle.includes('__vite__mapDeps')).toBe(false);
  });
});

describe('the worker source', () => {
  async function sourcesUnder(dir: string): Promise<Array<{ file: string; text: string }>> {
    const { globSync } = await import('node:fs');
    const files = globSync(`src/${dir}/**/*.ts`).filter((f: string) => !f.includes('.test.'));
    return Promise.all(
      files.map(async (file: string) => ({ file, text: await readFile(file, 'utf8') })),
    );
  }

  /**
   * A dynamic import here is what broke vault creation. Kept as a source rule
   * as well as a bundle one, because the source is where somebody reintroduces
   * it and where the comment explaining why they should not is visible.
   */
  it.each(['vault', 'background', 'shared', 'runtime'])(
    'has no dynamic import under %s/',
    async (dir) => {
      const offenders: string[] = [];
      for (const { file, text } of await sourcesUnder(dir)) {
        for (const [index, line] of text.split(/\r?\n/).entries()) {
          if (line.trimStart().startsWith('*') || line.trimStart().startsWith('//')) continue;
          if (/\bawait\s+import\s*\(/.test(line) || /[^.\w]import\s*\(\s*['"]/.test(line)) {
            offenders.push(`${file}:${index + 1} ${line.trim()}`);
          }
        }
      }
      expect(offenders, 'a dynamic import in worker code goes through __vitePreload').toEqual([]);
    },
  );

  it('imports the KDF statically, which is the fix itself', async () => {
    const crypto = await readFile('src/vault/crypto.ts', 'utf8');
    expect(crypto).toMatch(/^import \{ argon2id \} from 'hash-wasm';$/m);

    // Code lines only. The comment above `deriveArgon2Key` quotes the old
    // dynamic import on purpose, to explain why it is no longer there — and a
    // check that forbids naming the mistake makes the mistake harder to learn
    // from.
    const code = crypto
      .split(/\r?\n/)
      .filter((line) => !line.trimStart().startsWith('*') && !line.trimStart().startsWith('//'));
    expect(code.filter((line) => line.includes("import('hash-wasm')"))).toEqual([]);
  });
});
