/**
 * The document reader's models, fetched once at build time and pinned by hash.
 *
 * PaddleOCR publishes its models as ONNX archives on its own model host, not on
 * npm, so they cannot be installed like the rest of the dependencies. They are
 * fetched here instead — **at build time, never at run time**: the extension
 * ships them inside the package, and its CSP (`connect-src 'self'`) would refuse
 * a run-time fetch anyway.
 *
 * Each archive is pinned by SHA-256, so what ships is exactly what was measured
 * in the Phase 0 comparison and nothing else: a changed file on the host fails
 * the build rather than quietly changing what reads the user's documents.
 *
 * The archives land in `vendor/ocr-models/` (not committed). `ocrAssets()` in
 * `vite.config.ts` unpacks them into `dist/ocr/`.
 *
 * Usage: `node scripts/fetch-ocr-models.mjs` — a no-op when every archive is
 * already present and verified.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOST = 'https://paddle-model-ecology.bj.bcebos.com/paddlex/official_inference_model/paddle3.0.0';

export const OCR_MODELS = [
  {
    // Finds the text: one box per word or line, anywhere on the page.
    name: 'PP-OCRv5_mobile_det',
    sha256: '781056046c9ed77a15c94681605db6a0f62317c2e9cce6931c71da2478d4bc30',
  },
  {
    // Reads each box: English and every Latin-script character a document prints.
    name: 'en_PP-OCRv5_mobile_rec',
    sha256: '4424e851309b291b00aab8191cd4314cefbd2d1b2381ff8994019d262fa95e28',
  },
  {
    // Says which way up the page is, so a sideways photograph is turned first.
    name: 'PP-LCNet_x1_0_doc_ori',
    sha256: '274fe4b00126b0b47ef38073fc008d7b71dc67fd2fd742d3c37beb909d4f4f83',
  },
];

export const VENDOR_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'vendor', 'ocr-models');

export const archivePath = (name) => join(VENDOR_DIR, `${name}.tar`);

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function ensure(model) {
  const path = archivePath(model.name);
  if (existsSync(path) && sha256(readFileSync(path)) === model.sha256) return 'present';

  const url = `${HOST}/${model.name}_onnx_infer.tar`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${model.name}: HTTP ${response.status} from ${url}`);
  const bytes = Buffer.from(await response.arrayBuffer());

  const actual = sha256(bytes);
  if (actual !== model.sha256) {
    throw new Error(
      `${model.name}: the archive on the model host has changed (sha256 ${actual}, expected ` +
        `${model.sha256}). Nothing was written. Re-measure before accepting a new model.`,
    );
  }

  mkdirSync(VENDOR_DIR, { recursive: true });
  writeFileSync(path, bytes);
  return 'fetched';
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  for (const model of OCR_MODELS) {
    const outcome = await ensure(model);
    console.log(`${model.name}: ${outcome}`);
  }
}
