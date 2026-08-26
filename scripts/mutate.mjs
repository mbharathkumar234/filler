#!/usr/bin/env node
/**
 * A small mutation tester.
 *
 * The suite is large and written by the same author as the code, which makes
 * "1445 passing" a weak claim. This applies a single textual mutation to a
 * source file, runs the tests that are supposed to cover it, and records
 * whether they noticed.
 *
 *   killed   — a test failed. The test was doing its job.
 *   SURVIVED — everything still passed with the code broken. A hole.
 *
 * Survivors are the output that matters. Not every survivor is a bug (some
 * mutations are semantically equivalent), but every survivor is a line of code
 * no test actually constrains.
 *
 * Usage: node scripts/mutate.mjs <targets.json>
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const TARGETS = JSON.parse(readFileSync(process.argv[2], 'utf8'));

/** Textual mutations, applied to the Nth occurrence of a pattern. */
const RULES = [
  { name: 'boundary >= to >', find: />=/g, replace: '>' },
  { name: 'boundary <= to <', find: /<=/g, replace: '<' },
  { name: 'equality === to !==', find: /===/g, replace: '!==' },
  { name: 'equality !== to ===', find: /!==/g, replace: '===' },
  { name: 'logic && to ||', find: /&&/g, replace: '||' },
  { name: 'return true to false', find: /return true;/g, replace: 'return false;' },
  { name: 'return false to true', find: /return false;/g, replace: 'return true;' },
];

function occurrences(source, regex) {
  const out = [];
  let match;
  const re = new RegExp(regex.source, 'g');
  while ((match = re.exec(source)) !== null) out.push(match.index);
  return out;
}

function mutateAt(source, index, from, to) {
  return source.slice(0, index) + to + source.slice(index + from.length);
}

function lineOf(source, index) {
  return source.slice(0, index).split('\n').length;
}

const results = [];

for (const { file, tests } of TARGETS) {
  const original = readFileSync(file, 'utf8');

  for (const rule of RULES) {
    const spots = occurrences(original, rule.find);

    for (let i = 0; i < spots.length; i += 1) {
      const index = spots[i];
      const literal = original.slice(index).match(rule.find)?.[0] ?? '';
      if (literal === '') continue;

      const mutated = mutateAt(original, index, literal, rule.replace);
      if (mutated === original) continue;

      const line = lineOf(original, index);
      writeFileSync(file, mutated, 'utf8');

      let killed = false;
      let note = '';
      try {
        execSync(`npx vitest run ${tests.join(' ')} --reporter=dot`, {
          stdio: 'pipe',
          timeout: 300_000,
        });
      } catch (error) {
        killed = true;
        note = /Error|error TS/.test(String(error.stdout ?? '')) ? '' : '';
      }

      writeFileSync(file, original, 'utf8');

      results.push({ file, line, rule: rule.name, killed, note });
      process.stderr.write(killed ? '.' : `\nSURVIVED ${file}:${line} ${rule.name}\n`);
    }
  }
}

const survivors = results.filter((r) => !r.killed);
process.stderr.write('\n\n');
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
