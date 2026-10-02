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

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';

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
  /*
   * The document reader: its page, PaddleOCR's three models and their settings.
   *
   * A missing model does not degrade the feature, it breaks it — silently, in
   * a build that otherwise looks fine. The runtime's WebAssembly is checked
   * below, by pattern, because Vite names it with a content hash.
   */
  {
    path: 'dist/src/offscreen/ocr.html',
    why: 'The document reader has no page to run in; every photograph reads as unreadable.',
  },
  {
    path: 'dist/ocr/PP-OCRv5_mobile_det.onnx',
    why: 'The document reader cannot find text on a page.',
    minBytes: 1_000_000,
  },
  {
    path: 'dist/ocr/PP-OCRv5_mobile_det.json',
    why: 'The text detector has no thresholds.',
  },
  {
    path: 'dist/ocr/en_PP-OCRv5_mobile_rec.onnx',
    why: 'The document reader cannot read the text it finds.',
    minBytes: 1_000_000,
  },
  {
    path: 'dist/ocr/en_PP-OCRv5_mobile_rec.json',
    why: 'The recogniser has no character list, so every character would be unreadable.',
    minBytes: 1_000,
  },
  {
    path: 'dist/ocr/PP-LCNet_x1_0_doc_ori.onnx',
    why: 'The document reader cannot tell which way up a page is; a sideways photograph reads as nothing.',
    minBytes: 1_000_000,
  },
  {
    path: 'dist/ocr/PP-LCNet_x1_0_doc_ori.json',
    why: 'The orientation model has no labels, so its answer means nothing.',
  },
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

// ONNX Runtime's WebAssembly, emitted by Vite under a content-hashed name.
const runtime = existsSync('dist/assets')
  ? readdirSync('dist/assets').filter((name) => /^ort-wasm-simd-threaded.*\.wasm$/.test(name))
  : [];
if (runtime.length === 0) {
  problems.push(
    'dist/assets has no ort-wasm-simd-threaded*.wasm. The document reader has no runtime, and ' +
      'ONNX Runtime would try to fetch one.',
  );
} else if (runtime.some((name) => /jsep|jspi|asyncify/.test(name))) {
  problems.push(
    `dist/assets carries a WebGPU or JSPI build of ONNX Runtime (${runtime.join(', ')}). ` +
      'The reader runs on the CPU build only; the other is megabytes of dead weight.',
  );
} else if (runtime.length > 1) {
  problems.push(`dist/assets carries ONNX Runtime twice (${runtime.join(', ')}).`);
} else if (statSync(`dist/assets/${runtime[0]}`).size < 1_000_000) {
  problems.push(`dist/assets/${runtime[0]} is too small to be ONNX Runtime.`);
}

/*
 * The reader's threads.
 *
 * Two things have to survive the build for more than one thread to work, and
 * neither fails loudly when it does not — the reader just runs on one thread,
 * or, worse, starts a second reader inside every thread.
 */
if (existsSync('dist/manifest.json')) {
  const built = JSON.parse(readFileSync('dist/manifest.json', 'utf8'));
  if (
    built.cross_origin_embedder_policy?.value !== 'require-corp' ||
    built.cross_origin_opener_policy?.value !== 'same-origin'
  ) {
    problems.push(
      'dist/manifest.json does not isolate the extension\'s pages (cross_origin_embedder_policy ' +
        '/ cross_origin_opener_policy). The document reader would run on one thread.',
    );
  }
}

if (existsSync('dist/assets')) {
  const assets = readdirSync('dist/assets');
  const ownFile = assets.filter((name) => /^ort\.wasm.*\.js$/.test(name));
  const reader = assets.filter((name) => /^reader-worker.*\.js$/.test(name));
  if (ownFile.length !== 1) {
    problems.push(
      `ONNX Runtime should be one file of its own in dist/assets (found ${ownFile.length}). ` +
        'Each thread is started by loading the file the runtime lives in.',
    );
  }
  for (const name of reader) {
    // The runtime's thread entry, which must not be inside the reader itself.
    if (readFileSync(`dist/assets/${name}`, 'utf8').includes('em-pthread')) {
      problems.push(
        `dist/assets/${name} contains ONNX Runtime. Every thread it started would start a ` +
          'second document reader.',
      );
    }
  }
}

/*
 * pdf.js's worker code, which it runs on the calling thread (`documents/pdfjs.ts`).
 *
 * Without it every PDF fails to open, with "No GlobalWorkerOptions.workerSrc
 * specified" — which is what every PDF did, unnoticed, until a test opened one.
 */
if (existsSync('dist/assets')) {
  const pdfWorker = readdirSync('dist/assets').filter(
    (name) =>
      name.endsWith('.js') &&
      readFileSync(`dist/assets/${name}`, 'utf8').includes('globalThis.pdfjsWorker = {'),
  );
  if (pdfWorker.length === 0) {
    problems.push(
      "No file in dist/assets carries pdf.js's worker code. Every PDF would fail to open: " +
        'no text layer read, no portal copy made.',
    );
  }
}

if (problems.length > 0) {
  console.error('\nThe build did not produce a loadable extension:\n');
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error('');
  process.exit(1);
}

console.log('dist looks loadable: manifest, worker, content script, practice form.');
