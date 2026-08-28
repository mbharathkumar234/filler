#!/usr/bin/env node
/**
 * Refuse to call a build finished unless it produced a loadable extension.
 *
 * ## Why this is a build step and not a test
 *
 * A `dist` was shipped with **no `content.js` in it at all**. Chrome reports
 * that as "Could not load file: 'content.js'", which from the panel looks like
 * yet another mysterious scan failure and is really a missing file. The
 * extension loads, the worker runs, the panel opens, and nothing can read a
 * page — a silent, total failure produced by a build that exited 0.
 *
 * The content script is emitted by a second Vite config, because
 * `executeScript` injects a *classic* script and only `lib`/`iife` produces
 * one. That makes it a separate step, and a separate step is a skippable one:
 * it was skipped, and once it raced. Tests cannot catch this — they run against
 * whatever happens to be on disk.
 *
 * So the build checks its own output. Every failure here is loud, names the
 * file, and says what it means for the product.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';

/** Things without which the extension is not an extension. */
const REQUIRED = [
  { path: 'dist/manifest.json', why: 'Chrome cannot load the extension at all.' },
  { path: 'dist/service-worker-loader.js', why: 'The background worker will not start.' },
  {
    path: 'dist/content.js',
    why: 'Nothing can read a page. Every scan fails with "Could not load file: \'content.js\'".',
    minBytes: 10_000,
    /**
     * `executeScript` runs a classic script. A top-level `import` is a syntax
     * error there, and the file silently never parses — which is exactly what
     * shipped once.
     */
    classicScript: true,
  },
  { path: 'dist/practice/first-fill.html', why: 'The onboarding practice form is missing.' },
];

const problems = [];

for (const { path, why, minBytes, classicScript } of REQUIRED) {
  if (!existsSync(path)) {
    problems.push(`${path} is missing. ${why}`);
    continue;
  }

  const size = statSync(path).size;
  if (minBytes !== undefined && size < minBytes) {
    problems.push(`${path} is only ${size} bytes, which cannot be right. ${why}`);
    continue;
  }

  if (classicScript) {
    const code = readFileSync(path, 'utf8');
    const moduleSyntax = code
      .split('\n')
      .filter((line) => /^(import|export)[\s{'"(]/.test(line));

    if (moduleSyntax.length > 0) {
      problems.push(
        `${path} is an ES module (${moduleSyntax[0].trim()}). ` +
          'chrome.scripting.executeScript runs a classic script, so this will never parse.',
      );
    }
  }
}

if (problems.length > 0) {
  console.error('\nThe build did not produce a loadable extension:\n');
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error('');
  process.exit(1);
}

console.log('dist looks loadable: manifest, worker, content script, practice form.');
