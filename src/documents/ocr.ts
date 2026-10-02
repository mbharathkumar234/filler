/**
 * Which scripts this build can read (§ reading a document).
 *
 * The reader is PaddleOCR's English recognition model (`en_PP-OCRv5_mobile_rec`)
 * behind its text detector, both shipped inside the package and run on ONNX
 * Runtime in the offscreen reader. It reads the Latin script, digits and the
 * punctuation documents print.
 *
 * ## Why only Latin
 *
 * Measured on the user's own five documents (Phase 0): every value the vault
 * needs from a CBSE statement, a PUC certificate, an e-Aadhaar letter, a caste
 * certificate and an income certificate is printed in English, and PaddleOCR's
 * only Kannada model is its older generation, which read worse than no Kannada
 * at all. What Kannada on a page costs the English reading is handled where it
 * arises: the detector puts each word in its own box, and a box the English
 * model could only guess at is dropped before the field rules see it
 * (`layout.ts`, `SCRIPT_MISREAD_BELOW`).
 *
 * A Devanagari model exists in the same generation; adding it is one entry
 * here, one pinned archive in `scripts/fetch-ocr-models.mjs`, and a per-box
 * choice between the two recognisers.
 */

import type { IndicScript } from './indic';

/** The scripts the bundled recogniser reads. */
export const READABLE_SCRIPTS: readonly IndicScript[] = ['Latin'];

/** The scripts this build can read, for `OcrEngine.availableScripts`. */
export function readableWithBundled(): IndicScript[] {
  return [...READABLE_SCRIPTS];
}
