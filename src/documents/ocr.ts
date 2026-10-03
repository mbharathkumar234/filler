/**
 * Which scripts this build can read (§ reading a document).
 *
 * The reader is PaddleOCR's text detector and English recognition model
 * (`en_PP-OCRv5_mobile_rec`), with its recognisers for Devanagari, Telugu and
 * Tamil behind them — all shipped inside the package and run on ONNX Runtime in
 * the offscreen reader. The English model reads every box; a box it could only
 * guess at is read again by the recognisers for the scripts its owner's
 * documents can be in (`paddle-reader.ts` → `chooseReading`, `indic.ts` →
 * `readingScripts`).
 *
 * ## Why these and not the others
 *
 * Measured in the real reader on made-up lines: Hindi and Tamil names read
 * exactly (0.95–1.00), Telugu with an occasional conjunct wrong. PaddleOCR has
 * no light model for Bengali, Gujarati, Gurmukhi, Odia or Malayalam — only its
 * 0.9-billion-parameter vision-language model, far too large to ship in an
 * extension — and its only Kannada model is the older generation, published as
 * training weights only, which read the user's own cards worse than no Kannada
 * at all (Phase 0). What Kannada on a page costs the English reading is handled
 * where it arises: a box the English model could only guess at is dropped
 * before the field rules see it (`layout.ts`, `SCRIPT_MISREAD_BELOW`) — and it
 * is never given to the Telugu model, which read Kannada as Telugu at 0.92.
 */

import type { IndicScript } from './indic';

/** The scripts the bundled recognisers read. */
export const READABLE_SCRIPTS: readonly IndicScript[] = ['Latin', 'Devanagari', 'Telugu', 'Tamil'];

/** The scripts this build can read, for `OcrEngine.availableScripts`. */
export function readableWithBundled(): IndicScript[] {
  return [...READABLE_SCRIPTS];
}
