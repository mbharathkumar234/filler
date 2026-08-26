/**
 * Getting text out of a stored document (§ document extraction).
 *
 * ## Two very different sources, and why the order matters
 *
 * **A PDF's text layer is not OCR.** A downloaded e-Aadhaar, a DigiLocker
 * document, a digitally-issued PAN, a bank statement — these carry the real
 * characters, put there by whoever generated the file. Reading them is exact:
 * no misread digits, no confusion between `0` and `O`, nothing to check a
 * checksum against because there was never a guess. `pdfjs-dist` is already a
 * dependency for rasterising PDFs, so this costs nothing new.
 *
 * **A photograph of a card is OCR**, with everything that implies. It is a
 * guess, it is wrong sometimes, and the whole design of `extract.ts` exists to
 * survive that.
 *
 * So the order here is deliberate: **always try the text layer first**, and
 * only reach for the OCR engine when there is nothing to read. A surprising
 * number of the documents people actually upload are PDFs with perfectly good
 * text in them, and running OCR over those would turn exact data into a guess.
 *
 * ## Why the engine is a port
 *
 * `OcrEngine` is an interface the caller supplies rather than something this
 * module imports. Three reasons, in order of how much they matter:
 *
 *  1. **This file stays testable** without a WASM engine, a worker, or model
 *    files — the same reason `run-controller.ts` takes ports.
 *  2. **The engine is optional.** Image OCR needs a large dependency and model
 *    data; text-layer reading needs neither. A build without an engine still
 *    does the useful half, and says so rather than failing.
 *  3. **It keeps OCR out of the content script.** Hard rule 3 forbids reading a
 *    CAPTCHA. Nothing in `documents/` is reachable from page context, and
 *    `no-ocr-in-content.test.ts` asserts that against the built bundle.
 */

import type { DocumentMeta } from '@/shared/types';
import { detectScripts, readableScripts, type IndicScript } from './indic';
import { extractFromText, type ExtractionResult } from './extract';

/** How the text was obtained. The user should be told which. */
export type TextSource =
  /** Read exactly, from characters embedded in the file. */
  | 'pdf-text-layer'
  /** Recognised from pixels. A guess, however good. */
  | 'ocr'
  /** Nothing could be read. */
  | 'none';

export interface DocumentText {
  text: string;
  source: TextSource;
  scripts: IndicScript[];
  /** OCR's own confidence, 0–1, when it offers one. */
  engineConfidence?: number;
  /** Anything the user should know about how this was read. */
  notes: string[];
}

/**
 * An OCR engine, supplied by the caller.
 *
 * Deliberately minimal: bytes and a set of scripts in, text out. Anything
 * richer — bounding boxes, per-word confidence — would tie this interface to
 * one engine's shape.
 */
export interface OcrEngine {
  /** Which scripts this engine has models for right now. */
  availableScripts(): Promise<IndicScript[]>;
  recognise(
    bytes: Uint8Array,
    mime: string,
    scripts: IndicScript[],
  ): Promise<{ text: string; confidence?: number }>;
}

/** Reads a PDF's embedded text layer. Supplied by the caller for testability. */
export type PdfTextReader = (bytes: Uint8Array) => Promise<string>;

export interface ReadOptions {
  pdfText?: PdfTextReader;
  ocr?: OcrEngine;
  /**
   * Scripts to try, when the caller knows better than we can guess — e.g. the
   * user picked their language. Otherwise decided from whatever text turns up.
   */
  scripts?: IndicScript[];
}

/**
 * Below this many characters, a PDF's "text layer" is furniture.
 *
 * Scanned PDFs frequently carry a few stray characters — a header, a page
 * number stamped by the scanner — while the actual content is an image.
 * Accepting those as the document's text would skip OCR and then find nothing.
 */
const MIN_TEXT_LAYER = 40;

export async function readDocumentText(
  bytes: Uint8Array,
  meta: Pick<DocumentMeta, 'mime'>,
  options: ReadOptions = {},
): Promise<DocumentText> {
  const notes: string[] = [];

  // 1. The exact path.
  if (meta.mime === 'application/pdf' && options.pdfText) {
    try {
      const text = (await options.pdfText(bytes)).trim();
      if (text.length >= MIN_TEXT_LAYER) {
        return {
          text,
          source: 'pdf-text-layer',
          scripts: detectScripts(text),
          notes: ['Read directly from the document, so the characters are exact.'],
        };
      }
      if (text.length > 0) {
        notes.push('This PDF is a scan with only a little text in it, so it was read as an image.');
      }
    } catch {
      notes.push('The document’s own text could not be read, so it was read as an image instead.');
    }
  }

  // 2. The guessing path.
  if (!options.ocr) {
    return {
      text: '',
      source: 'none',
      scripts: [],
      notes: [
        ...notes,
        'Reading text from photographs is not available in this build. A PDF downloaded from the issuing website can still be read exactly.',
      ],
    };
  }

  const available = await options.ocr.availableScripts();
  const wanted = (options.scripts ?? readableScripts()).filter((s) => available.includes(s));

  if (wanted.length === 0) {
    return {
      text: '',
      source: 'none',
      scripts: [],
      notes: [
        ...notes,
        'No language pack is installed for this document’s script. Add one, or type the details in yourself.',
      ],
    };
  }

  const result = await options.ocr.recognise(bytes, meta.mime, wanted);
  const text = result.text.trim();

  return {
    text,
    source: text === '' ? 'none' : 'ocr',
    scripts: detectScripts(text),
    ...(result.confidence === undefined ? {} : { engineConfidence: result.confidence }),
    notes: [
      ...notes,
      ...(text === ''
        ? ['Nothing could be read from this image. A sharper, straighter photo in better light usually fixes it.']
        : ['Recognised from the image, so please check each value against the card.']),
    ],
  };
}

/**
 * The whole job: read a document, then propose values from it.
 *
 * Confidence is scaled down for anything recognised from pixels. A value read
 * out of a PDF's text layer is exact and deserves its score; the same value
 * guessed from a photograph does not, and the difference has to survive all the
 * way to the screen where somebody decides whether to save it.
 */
export async function readAndExtract(
  bytes: Uint8Array,
  meta: Pick<DocumentMeta, 'mime'>,
  options: ReadOptions = {},
): Promise<ExtractionResult & { read: DocumentText }> {
  const read = await readDocumentText(bytes, meta, options);
  const extracted = extractFromText(read.text);

  if (read.source !== 'ocr') return { ...extracted, read };

  return {
    ...extracted,
    read,
    candidates: extracted.candidates.map((candidate) => ({
      ...candidate,
      // A checksum is a checksum whatever read it, so a verified value keeps
      // its standing. Everything else was a guess about pixels.
      confidence: candidate.verified ? candidate.confidence : candidate.confidence * 0.85,
    })),
  };
}
