/**
 * Document derivation (§ Phase 2): master + constraint → a compliant file.
 *
 * The raster operations are injected as a `RasterBackend`. That split is what
 * lets §6.1's "unit tests, no DOM" rule hold for the interesting half — the
 * decisions about dimensions, format, and quality are all made here in plain
 * TypeScript, and only the pixel pushing needs a canvas.
 *
 * Failure is a returned value, never a thrown exception, because "your photo
 * cannot meet this portal's limits" is a normal outcome the user must read and
 * act on — not an error to be logged and swallowed.
 */

import type { DocConstraint } from '@/shared/types';
import { describeConstraint, shortMime } from './constraints';
import {
  inspectQuality,
  planTargetBox,
  type FitMode,
  type QualityWarning,
  type SourceImage,
  type TargetBox,
} from './geometry';
import {
  explainFailure,
  searchQuality,
  type QualityAttempt,
  type SearchOptions,
} from './quality-search';

// ---------------------------------------------------------------------------
// The backend seam
// ---------------------------------------------------------------------------

export interface RasterSource {
  width: number;
  height: number;
  /** Opaque handle the backend understands (ImageBitmap, test double, …). */
  handle: unknown;
}

export interface RasterBackend {
  /** Decode image bytes. Must reject for anything it cannot read. */
  decode(bytes: Uint8Array, mime: string): Promise<RasterSource>;
  /** Draw `source` into a `width`×`height` canvas using `fit`, returning a new source. */
  resize(source: RasterSource, box: TargetBox): Promise<RasterSource>;
  /** Encode to JPEG at `quality` (0–1). */
  encodeJpeg(source: RasterSource, quality: number): Promise<Uint8Array>;
  /** Encode to PNG. Lossless, so no quality parameter. */
  encodePng(source: RasterSource): Promise<Uint8Array>;
  /** Render the first page(s) of a PDF to a raster source. */
  rasterisePdf(bytes: Uint8Array, targetWidth: number): Promise<RasterSource>;
  /** Wrap already-encoded JPEG bytes in a single-page PDF. */
  wrapJpegInPdf(jpeg: Uint8Array, width: number, height: number): Promise<Uint8Array>;
  /** Release any native resources held by a source. */
  release?(source: RasterSource): void;
}

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface DerivedFile {
  bytes: Uint8Array;
  mime: string;
  width: number;
  height: number;
  /** JPEG quality that won, when the output is a JPEG. */
  quality?: number;
  fit: FitMode;
  warnings: QualityWarning[];
  /** Every encode attempted, for the audit log and the "explain this" UI. */
  attempts: QualityAttempt[];
}

export interface DerivationFailure {
  /** Human-readable, specific, and actionable. Shown directly to the user. */
  reason: string;
  code:
    | 'unsupported-source'
    | 'unsatisfiable-size'
    | 'no-acceptable-format'
    | 'decode-failed';
  /** Present when we got far enough to measure something. */
  attempts?: QualityAttempt[];
}

export type DerivationResult =
  | ({ ok: true } & DerivedFile)
  | ({ ok: false } & DerivationFailure);

export interface DeriveOptions extends SearchOptions {
  /** Overrides the default output-format choice. */
  preferMime?: string;
}

// ---------------------------------------------------------------------------
// Format selection
// ---------------------------------------------------------------------------

const RASTER_MIMES = new Set(['image/jpeg', 'image/png']);

/**
 * Choose the output format.
 *
 * JPEG wins whenever it is allowed, because it is the only format here with a
 * quality dial — and a byte window is unsatisfiable without one. PNG is chosen
 * only when the portal forbids JPEG, and PDF only when it is the sole option.
 */
export function chooseOutputMime(
  constraint: DocConstraint,
  sourceMime: string,
  prefer?: string,
): string | null {
  const allowed = constraint.mime.length > 0 ? constraint.mime : [sourceMime];

  if (prefer && allowed.includes(prefer)) return prefer;
  if (allowed.includes('image/jpeg')) return 'image/jpeg';
  if (allowed.includes('application/pdf')) return 'application/pdf';
  if (allowed.includes('image/png')) return 'image/png';
  return null;
}

// ---------------------------------------------------------------------------
// Derivation
// ---------------------------------------------------------------------------

/**
 * Produce a file satisfying `constraint` from master `bytes`.
 *
 * Steps: decode (rasterising a PDF source if needed) → plan the pixel box →
 * resize → encode, binary-searching JPEG quality into the byte window →
 * optionally wrap in a PDF.
 */
export async function derive(
  backend: RasterBackend,
  bytes: Uint8Array,
  sourceMime: string,
  constraint: DocConstraint,
  options: DeriveOptions = {},
): Promise<DerivationResult> {
  const outputMime = chooseOutputMime(constraint, sourceMime, options.preferMime);
  if (outputMime === null) {
    return {
      ok: false,
      code: 'no-acceptable-format',
      reason:
        `This portal accepts only ${constraint.mime.map(shortMime).join(' or ')}, ` +
        `and we cannot produce that from a ${shortMime(sourceMime)} file.`,
    };
  }

  // ---- decode -------------------------------------------------------------
  let source: RasterSource;
  try {
    if (sourceMime === 'application/pdf') {
      // Rasterise generously; the resize step below scales down to the target.
      source = await backend.rasterisePdf(bytes, pdfRasterWidth(constraint));
    } else if (RASTER_MIMES.has(sourceMime)) {
      source = await backend.decode(bytes, sourceMime);
    } else {
      return {
        ok: false,
        code: 'unsupported-source',
        reason: `We cannot read ${shortMime(sourceMime)} files. Upload a JPEG, PNG, or PDF.`,
      };
    }
  } catch (error) {
    return {
      ok: false,
      code: 'decode-failed',
      reason:
        'That file could not be opened as an image. It may be corrupt, or its ' +
        `contents may not match its ${shortMime(sourceMime)} extension.`,
      ...(error instanceof Error ? {} : {}),
    };
  }

  const original: SourceImage = { width: source.width, height: source.height };

  // ---- plan and resize ----------------------------------------------------
  const box = planTargetBox(original, constraint);
  const warnings = inspectQuality(original, box);

  const resized =
    box.width === source.width && box.height === source.height && box.fit !== 'pad'
      ? source
      : await backend.resize(source, box);

  try {
    // ---- encode -----------------------------------------------------------
    if (outputMime === 'image/png') {
      const png = await backend.encodePng(resized);
      const window = { ...pick(constraint) };
      if (window.maxBytes !== undefined && png.length > window.maxBytes) {
        return {
          ok: false,
          code: 'unsatisfiable-size',
          reason:
            `This portal requires PNG under ${Math.round(window.maxBytes / 1024)} KB, but PNG ` +
            `has no quality setting to trade away — the smallest we can make it is ` +
            `${Math.round(png.length / 1024)} KB. Reduce the required dimensions if the portal allows it.`,
        };
      }
      return {
        ok: true,
        bytes: png,
        mime: 'image/png',
        width: resized.width,
        height: resized.height,
        fit: box.fit,
        warnings,
        attempts: [{ quality: 1, bytes: png.length }],
      };
    }

    // JPEG, and PDF-wrapping-a-JPEG, both search the same quality dial.
    // For a PDF the byte window applies to the finished PDF, so leave headroom
    // for the container: pdf-lib adds a small fixed overhead around the image.
    const wrapping = outputMime === 'application/pdf';
    const window = pick(constraint);
    const searchWindow = wrapping ? shrinkForPdfOverhead(window) : window;

    const search = await searchQuality(
      async (quality) => {
        const data = await backend.encodeJpeg(resized, quality);
        return { bytes: data.length, data };
      },
      searchWindow,
      options,
    );

    if (!search.ok) {
      return {
        ok: false,
        code: 'unsatisfiable-size',
        reason: explainFailure(search.reason, searchWindow, box, search.best),
        attempts: search.attempts,
      };
    }

    if (!wrapping) {
      return {
        ok: true,
        bytes: search.data,
        mime: 'image/jpeg',
        width: resized.width,
        height: resized.height,
        quality: search.quality,
        fit: box.fit,
        warnings,
        attempts: search.attempts,
      };
    }

    const pdf = await backend.wrapJpegInPdf(search.data, resized.width, resized.height);
    if (window.maxBytes !== undefined && pdf.length > window.maxBytes) {
      return {
        ok: false,
        code: 'unsatisfiable-size',
        reason:
          `The finished PDF is ${Math.round(pdf.length / 1024)} KB, over the portal's ` +
          `${Math.round(window.maxBytes / 1024)} KB limit. The PDF container itself adds overhead ` +
          'that cannot be compressed away.',
        attempts: search.attempts,
      };
    }

    return {
      ok: true,
      bytes: pdf,
      mime: 'application/pdf',
      width: resized.width,
      height: resized.height,
      quality: search.quality,
      fit: box.fit,
      warnings,
      attempts: search.attempts,
    };
  } finally {
    backend.release?.(resized);
    if (resized !== source) backend.release?.(source);
  }
}

function pick(constraint: DocConstraint): { minBytes?: number; maxBytes?: number } {
  const window: { minBytes?: number; maxBytes?: number } = {};
  if (constraint.minBytes !== undefined) window.minBytes = constraint.minBytes;
  if (constraint.maxBytes !== undefined) window.maxBytes = constraint.maxBytes;
  return window;
}

/** Reserve room for the PDF container so the wrapped result still fits. */
function shrinkForPdfOverhead(window: { minBytes?: number; maxBytes?: number }) {
  const OVERHEAD = 2 * 1024;
  const out = { ...window };
  if (out.maxBytes !== undefined) out.maxBytes = Math.max(1024, out.maxBytes - OVERHEAD);
  if (out.minBytes !== undefined) out.minBytes = Math.max(0, out.minBytes - OVERHEAD);
  return out;
}

/** How wide to rasterise a PDF page before downscaling to the target. */
function pdfRasterWidth(constraint: DocConstraint): number {
  if (constraint.maxW) return Math.max(constraint.maxW, 1000);
  if (constraint.dimensionsMm) {
    return Math.max(1000, Math.round((constraint.dimensionsMm[0] / 25.4) * (constraint.dpi ?? 300)));
  }
  return 1654; // A4 width at 200 DPI — a sensible default for certificates.
}

/** One-line summary of a derivation, for the review screen (Phase 7). */
export function describeDerivation(file: DerivedFile, constraint: DocConstraint): string {
  const kb = Math.round(file.bytes.length / 1024);
  return (
    `${shortMime(file.mime)}, ${kb} KB, ${file.width}×${file.height} px ` +
    `(required: ${describeConstraint(constraint)})`
  );
}
