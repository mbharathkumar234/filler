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
import { extractFromText, type ExtractionHint, type ExtractionResult } from './extract';
import type { PageBox } from './evidence-region';
import type { ReadTable } from './table';

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
  /**
   * Where each line of `text` sat on the page, as shares of the page — line
   * `i` of the text is entry `i` here. Present only for text recognised from
   * pixels, and only when it is provably in step with the text: it is what
   * lets the suggestion screen show the piece of the card a value came from,
   * and the wrong piece would be worse than none.
   */
  lines?: TextLine[];
  /** Pages read as something other than the stored page, which `lines` on them refer to. */
  pageImages?: PageImage[];
  /** The tables the reader found, cell by cell (`table.ts`). Only from pixels: a text layer has none. */
  tables?: ReadTable[];
}

/**
 * A page as it was read, when that is not the page as it is stored: a photo
 * flattened before it was read. Lines from that page sit on this image, so a
 * picture of where a value was read is cut from it.
 */
export interface PageImage {
  /** From 1. */
  page: number;
  image: Uint8Array;
  mime: string;
}

/** A line of recognised text and the box that held it, as shares of the page. */
export interface TextLine {
  text: string;
  box: PageBox;
  /** The page it sat on, from 1, for a document read page by page. Absent: the first. */
  page?: number;
  /**
   * Quarter turns clockwise that stood its page upright before it was read.
   * `box` is a place on that upright page, so whoever cuts a piece out of the
   * stored document needs this to find it. Absent: the page was upright.
   */
  turns?: 1 | 2 | 3;
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
    /** What a locked PDF opens with (`pdf-lock.ts`). */
    password?: string,
  ): Promise<{
    text: string;
    confidence?: number;
    /**
     * Anything the engine learned about the picture that the text cannot say —
     * that the scan is too small to read reliably, for instance. Shown to the
     * user beside the values, because "the photo is the limit" is more use than
     * a list of values misread from it.
     */
    notes?: string[];
    /** Where each line of `text` sat — on which page, turned how far — when the engine knows. */
    lines?: TextLine[];
    /** Pages it read as something other than the stored page — a photo flattened first. */
    pageImages?: PageImage[];
    /** The tables on the pages, cell by cell, when it found any. */
    tables?: ReadTable[];
  }>;
}

/** Reads a PDF's embedded text layer. Supplied by the caller for testability. */
export type PdfTextReader = (bytes: Uint8Array, password?: string) => Promise<string>;

/** What reading needs to know about the file: its type, and what a locked PDF opens with. */
export type ReadMeta = Pick<DocumentMeta, 'mime'> & { password?: string };

export interface ReadOptions {
  pdfText?: PdfTextReader;
  ocr?: OcrEngine;
  /**
   * What the vault knows about this document that its text cannot say — the
   * slot it is filed under. A marks card does not reliably print whose marks
   * card it is; the slot the user chose does.
   */
  hint?: ExtractionHint;
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
  meta: ReadMeta,
  options: ReadOptions = {},
): Promise<DocumentText> {
  const notes: string[] = [];

  // 1. The exact path.
  if (meta.mime === 'application/pdf' && options.pdfText) {
    try {
      const text = (await options.pdfText(bytes, meta.password)).trim();
      if (text.length >= MIN_TEXT_LAYER) {
        return {
          text,
          source: 'pdf-text-layer',
          scripts: detectScripts(text),
          // How it was read is `source`, which the screen puts in its own words.
          notes: [],
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

  const result = await options.ocr.recognise(bytes, meta.mime, wanted, meta.password);
  const text = result.text.trim();

  // Boxes are kept only if they are, line for line, the text being returned.
  const inStep =
    result.lines !== undefined && result.lines.map((line) => line.text).join('\n') === text;

  return {
    text,
    source: text === '' ? 'none' : 'ocr',
    scripts: detectScripts(text),
    ...(result.confidence === undefined ? {} : { engineConfidence: result.confidence }),
    // Pages and turns travel on the lines, so they go wherever the lines go —
    // and the flattened pages the lines sit on, with them.
    ...(inStep && text !== '' ? { lines: result.lines! } : {}),
    ...(inStep && text !== '' && result.pageImages !== undefined && result.pageImages.length > 0
      ? { pageImages: result.pageImages }
      : {}),
    ...(text !== '' && result.tables !== undefined && result.tables.length > 0 ? { tables: result.tables } : {}),
    // Not "recognised from an image, so check each value": that is what
    // `source` says, and the screen says it once, in its own words. Driven
    // through the real panel, the two said it one under the other.
    notes: [
      ...notes,
      ...(text === '' ? ['A sharper, straighter photo in better light usually fixes it.'] : []),
      ...(result.notes ?? []),
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
  meta: ReadMeta,
  options: ReadOptions = {},
): Promise<ExtractionResult & { read: DocumentText }> {
  const read = await readDocumentText(bytes, meta, options);
  const extracted = extractFromText(read.text, options.hint ?? {}, { tables: read.tables ?? [] });

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
