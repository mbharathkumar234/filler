#!/usr/bin/env node
/**
 * Mutation-test the submit guard against the e2e suite.
 *
 * Separate from `mutate.mjs` for one reason: the guard's behaviour only exists
 * in a browser. Running it under vitest reports nearly everything as surviving,
 * not because the tests are weak but because the tests that cover it are
 * Playwright specs, which `mutate.mjs` never invokes. A first attempt at this
 * did exactly that and produced a false alarm on the most safety-critical file
 * in the project.
 *
 * So this one runs the real specs, and — because the first attempt also had a
 * file-write bug that silently left the source unmutated — it **verifies the
 * mutation actually landed** before believing any result. A mutation tester
 * that reports "survived" for a mutation it never applied is worse than none:
 * it produces confident, wrong reassurance about the P2 control.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const FILE = 'src/content/submit-guard.ts';
const SPECS = 'tests/e2e/fill.spec.ts tests/e2e/guard-adversarial.spec.ts';
const UNIT = 'src/content/submit-guard.test.ts src/content/fill-run.test.ts';

const original = readFileSync(FILE, 'utf8');

/** Fail-open mutations only: the direction that breaks P2. */
const RULES = [
  { find: 'return false;', replace: 'return true;' },
  { find: '&&', replace: '||' },
  { find: '!==', replace: '===' },
];

function lineAt(source, index) {
  return source.slice(0, index).split(/\r\n|\r|\n/).length;
}

const results = [];

for (const { find, replace } of RULES) {
  let from = 0;
  for (;;) {
    const index = original.indexOf(find, from);
    if (index === -1) break;
    from = index + find.length;

    const line = lineAt(original, index);
    const mutated = original.slice(0, index) + replace + original.slice(index + find.length);

    writeFileSync(FILE, mutated, 'utf8');

    // Verify. Without this the whole run is theatre.
    const readBack = readFileSync(FILE, 'utf8');
    if (readBack !== mutated) {
      writeFileSync(FILE, original, 'utf8');
      throw new Error(`mutation at line ${line} did not land — aborting rather than reporting nonsense`);
    }

    // Both suites. The guard's logic is split between pure predicates that
    // jsdom can reach and behaviour that only exists in a real browser, so
    // scoring it against either alone slanders the other.
    let killed = false;
    try {
      execSync(`npx vitest run ${UNIT} --reporter=dot`, { stdio: 'pipe', timeout: 600_000 });
    } catch {
      killed = true;
    }
    if (!killed) {
      try {
        execSync(`npx playwright test ${SPECS}`, { stdio: 'pipe', timeout: 900_000 });
      } catch {
        killed = true;
      }
    }

    writeFileSync(FILE, original, 'utf8');
    if (readFileSync(FILE, 'utf8') !== original) {
      throw new Error(`FAILED TO RESTORE ${FILE} — restore it from git before doing anything else`);
    }

    results.push({ line, rule: `${find} -> ${replace}`, killed });
    process.stderr.write(killed ? `killed  ${line}\n` : `SURVIVED ${line}  ${find} -> ${replace}\n`);
  }
}

const survivors = results.filter((r) => !r.killed);
console.log(
  JSON.stringify(
    {
      total: results.length,
      killed: results.length - survivors.length,
      survived: survivors.length,
      score: `${(((results.length - survivors.length) / results.length) * 100).toFixed(1)}%`,
      survivors,
    },
    null,
    2,
  ),
);
