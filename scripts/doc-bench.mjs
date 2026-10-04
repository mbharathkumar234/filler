#!/usr/bin/env node
/**
 * `npm run doc-bench` — how well the extension reads your own documents
 * (U0.M7, `MASTER_PROMPT.md`), measured on your own machine.
 *
 * Put the documents and an answer key in `.private/bench/` (git-ignored):
 *
 *   .private/bench/answers.json
 *     [{ "file": "marks-card.jpg", "slot": "doc.marksheet_10",
 *        "fields": { "identity.full_name": "…", "education.class_10.institution": { "contains": "…" } } }]
 *
 * Each document is read by the built extension's own reader (`npm run build`
 * first), in a browser window that opens and closes by itself. The readings
 * stay in `.private/bench/reads.json`. Then the real extraction pipeline —
 * RBI's and India Post's lists included — scores them
 * (`src/corpus/doc-bench.run.ts`), and only counts and field names are written,
 * to `bench/doc-results.json`.
 *
 * Photos only (JPEG, PNG, WebP) for now; a PDF is reported as not measured.
 */

/* global chrome -- the function handed to `worker.evaluate` runs inside the extension's worker */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = resolve(process.env.DOC_BENCH_DIR ?? join(ROOT, '.private', 'bench'));
const DIST = join(ROOT, 'dist');
const MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };

function fail(message) {
  console.error(message);
  process.exit(2);
}

if (!existsSync(join(DIR, 'answers.json'))) {
  fail(`No answer key: ${join(DIR, 'answers.json')} does not exist. See the top of scripts/doc-bench.mjs for its shape.`);
}
if (!existsSync(join(DIST, 'manifest.json'))) fail('No built extension to read with. Run `npm run build` first.');

const answers = JSON.parse(readFileSync(join(DIR, 'answers.json'), 'utf8'));
const { chromium } = await import('@playwright/test');
const profile = mkdtempSync(join(tmpdir(), 'doc-bench-'));
const context = await chromium.launchPersistentContext(profile, {
  headless: false,
  args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`, '--no-first-run'],
});
const reads = [];
try {
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  const id = new URL(worker.url()).host;
  const reader = await context.newPage();
  await reader.goto(`chrome-extension://${id}/src/offscreen/ocr.html`);
  const ask = (payload) =>
    worker.evaluate((message) => chrome.runtime.sendMessage({ __af: true, at: Date.now(), payload: message }), payload);

  for (const [index, answer] of answers.entries()) {
    const mime = MIME[extname(answer.file).toLowerCase()];
    if (mime === undefined) {
      console.log(`${index + 1}. ${answer.slot}: not measured (photos only, for now).`);
      reads.push({ index, unsupported: true });
      continue;
    }
    const scripts = (answer.scripts ?? ['Latin', 'Devanagari']).filter((script) => script !== 'Latin');
    const started = Date.now();
    const result = await ask({
      type: 'ocr:recognise',
      image: readFileSync(join(DIR, answer.file)).toString('base64'),
      mime,
      ...(scripts.length > 0 ? { scripts } : {}),
    });
    const ms = Date.now() - started;
    if (!result?.ok) throw new Error(`${answer.slot}: the reader failed (${result?.error ?? 'no answer'}).`);
    reads.push({ index, ms, items: result.data.items, tables: result.data.tables ?? [], seals: result.data.seals ?? [] });
    console.log(`${index + 1}. ${answer.slot}: read in ${ms} ms.`);
  }
} finally {
  await context.close();
  rmSync(profile, { recursive: true, force: true });
}
writeFileSync(join(DIR, 'reads.json'), JSON.stringify(reads));

const out = process.env.DOC_BENCH_OUT ?? join(ROOT, 'bench', 'doc-results.json');
const scored = spawnSync('npx', ['vitest', 'run', '--config', 'vitest.bench.config.ts', 'src/corpus/doc-bench.run.ts'], {
  cwd: ROOT,
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: { ...process.env, DOC_BENCH_DIR: DIR, DOC_BENCH_OUT: out },
});
process.exit(scored.status ?? 1);
