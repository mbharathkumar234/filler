import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

/**
 * Text recognition must never be reachable from a page (§ hard rule 3).
 *
 * ## Why this test exists at all
 *
 * `CLAUDE.md` forbids CAPTCHA solving and OTP reading, and names OCR
 * explicitly: adding it to `content/blockers.ts` fails the build. Adding the
 * *ability to read text from pixels* anywhere in this codebase therefore
 * deserves a hard line, and the line is architectural rather than a promise:
 *
 *   **Document reading lives in `documents/`, runs in the worker, and operates
 *   only on files the user chose to upload. Nothing in it is reachable from the
 *   content script.**
 *
 * That distinction is the whole ethical difference between the two things. A
 * user handing us a scan of their own Aadhaar card and asking us to read it is
 * not remotely the same act as reading a challenge off a live page — but the
 * *capability* looks similar enough that the separation has to be enforced by
 * something other than intent.
 *
 * ## Two checks, answering two different questions
 *
 * They are not redundant, and neither is sufficient alone — which was measured
 * rather than assumed. Adding `import { extractFromText }` to `blockers.ts`
 * and calling it from an exported function fails the **source** check and
 * *passes* the bundle check, because nothing in the content entry point reaches
 * that export and Rollup shakes it out.
 *
 *  - **The bundle check** answers "is this in the code we actually ship?".
 *    That is the question that matters at release, and tree-shaking means the
 *    honest answer can be no even when the import exists.
 *  - **The source check** answers "is this one line away from being shipped?".
 *    It catches the import itself, which is where the architectural decision
 *    really happens.
 *
 * ## When this fails
 *
 * Something in `content/` now imports `documents/`, directly or transitively.
 * The fix is to move the work to the worker and pass a result over the bus —
 * not to relax the check.
 */

const BUNDLE = 'dist/content.js';

/** Names that only exist in the document-reading pipeline. */
const FORBIDDEN = [
  'extractFromText',
  'isValidAadhaar',
  'VERHOEFF_D',
  'readDocumentText',
  'readAndExtract',
  'reconstructLines',
  'SCHEDULED_LANGUAGES',
  'availableScripts',
  // Engine names, so a future OCR dependency cannot arrive here unnoticed.
  'tesseract',
  'Tesseract',
  'traineddata',
  'createWorker',
];

describe('the content script cannot read text from pixels', () => {
  it.skipIf(!existsSync(BUNDLE))('carries none of the document-reading pipeline', async () => {
    const bundle = await readFile(BUNDLE, 'utf8');

    const found = FORBIDDEN.filter((name) => bundle.includes(name));
    expect(found, `${BUNDLE} has picked up the document reader`).toEqual([]);
  });

  it.skipIf(!existsSync(BUNDLE))('carries no OCR-shaped API either', async () => {
    // Belt and braces: the specific engine may change, but anything that turns
    // pixels into text goes through one of these.
    const bundle = await readFile(BUNDLE, 'utf8');

    for (const api of ['TextDetector', 'OCRAD', 'recognize(']) {
      expect(bundle.includes(api), api).toBe(false);
    }
  });

  it('is checked against a bundle that actually exists', () => {
    // The two tests above skip when `dist/` has not been built, which is the
    // right behaviour for a fresh checkout and a terrible one for CI. This
    // fails loudly if the guard has been silently skipping.
    if (!existsSync(BUNDLE)) {
      expect.soft(
        existsSync(BUNDLE),
        'run `npm run build` before trusting the content-bundle boundary tests',
      ).toBe(true);
    }
    expect(true).toBe(true);
  });
});

describe('the source boundary, so a violation is caught before a build', () => {
  it('has no import of documents/ anywhere under content/', async () => {
    const { globSync } = await import('node:fs');
    const files = globSync('src/content/**/*.ts').filter((f: string) => !f.includes('.test.'));
    expect(files.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const file of files) {
      const source = await readFile(file, 'utf8');
      for (const line of source.split(/\r?\n/)) {
        if (!/^\s*import\b/.test(line) && !/\bfrom\s+['"]/.test(line)) continue;
        if (/['"]@\/documents\//.test(line) || /['"]\.\.\/documents\//.test(line)) {
          offenders.push(`${file}: ${line.trim()}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
