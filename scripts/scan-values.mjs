#!/usr/bin/env node
/**
 * Look for the user's real values anywhere in the repository (U0.M9,
 * `MASTER_PROMPT.md`): in every file in the working tree, tracked or not, and
 * in every commit in its history.
 *
 * The values come from `.private/values.txt`, which is git-ignored and never
 * leaves the machine: one value per line, `#` for comments. A value found is
 * reported by its line number in that file, never by the value itself, so this
 * script's own output is safe to paste anywhere.
 *
 * Exit 0: nothing found. Exit 1: something found. Exit 2: nothing to look for
 * (no values file), which is not the same as clean.
 *
 *   npm run scan-values
 *   SCAN_VALUES_FILE=path/to/values.txt npm run scan-values
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const file = resolve(process.env.SCAN_VALUES_FILE ?? '.private/values.txt');
if (!existsSync(file)) {
  console.error(
    `No values to look for: ${file} does not exist.\n` +
      'Put the values from your own documents in it, one per line (it is git-ignored). Until then nothing has been checked.',
  );
  process.exit(2);
}

const values = readFileSync(file, 'utf8')
  .split(/\r?\n/)
  .map((line, index) => ({ value: line.trim(), line: index + 1 }))
  .filter(({ value }) => value !== '' && !value.startsWith('#'));
if (values.length === 0) {
  console.error(`${file} lists no values. Until it does, nothing has been checked.`);
  process.exit(2);
}

const git = (...args) => {
  try {
    return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (error) {
    // git grep exits 1 when it finds nothing.
    if (error.status === 1) return '';
    throw error;
  }
};

const revisions = git('rev-list', '--all').split('\n').filter(Boolean);
const found = [];
for (const { value, line } of values) {
  const tree = git('grep', '--untracked', '-I', '-i', '-F', '-l', '-e', value).split('\n').filter(Boolean);
  const history =
    revisions.length === 0
      ? []
      : git('grep', '-I', '-i', '-F', '-l', '-e', value, ...revisions)
          .split('\n')
          .filter(Boolean)
          .map((hit) => hit.replace(/^([0-9a-f]{7})[0-9a-f]+:/, '$1:'));
  if (tree.length > 0 || history.length > 0) found.push({ line, tree, history: [...new Set(history)] });
}

console.log(`${values.length} values, ${revisions.length} commits.`);
if (found.length === 0) {
  console.log('Nothing found, in the working tree or in history.');
  process.exit(0);
}
for (const { line, tree, history } of found) {
  console.log(`Value on line ${line} of the values file:`);
  for (const path of tree) console.log(`  working tree: ${path}`);
  for (const hit of history.slice(0, 20)) console.log(`  history: ${hit}`);
  if (history.length > 20) console.log(`  … and ${history.length - 20} more in history`);
}
process.exit(1);
