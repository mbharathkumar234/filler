/**
 * Document request handlers (§ Phase 2).
 *
 * Like `vault-service.ts`, this is a deliberately small privileged surface: it
 * is the only place document bytes are decrypted, derived, and handed back to
 * the UI. Derivation runs here rather than in the panel so the master never
 * leaves the worker that holds the key.
 */

import type { DocumentRequest, Result, ResponseMap } from '@/shared/messages';
import { derive, type DerivedFile } from '@/documents/derive';
import { measureShape } from '@/documents/raster';
import { roleFor, trimsToInk } from '@/documents/intake';
import { createRasterBackend } from '@/documents/raster';
import { openVaultDb } from '@/vault/db';
import {
  deleteMaster,
  getCachedVariant,
  getMaster,
  getMasterByKey,
  listMasters,
  putMaster,
  putVariant,
} from '@/vault/document-store';
import { readAndExtract, type OcrEngine, type TextLine } from '@/documents/read-document';
import { regionForLine, unturnBox } from '@/documents/evidence-region';
import { bytesToBase64 } from '@/shared/base64';
import { readPdfText } from '@/documents/pdf-text';
import type { Candidate, DocumentType } from '@/documents/extract';
import type { TextSource } from '@/documents/read-document';
import { VaultLockedError, isUnlocked, withKey } from '@/vault/session';
import { inspectQuality, planTargetBox } from '@/documents/geometry';
import { canPassThrough } from '@/documents/field-constraint';
import type { FieldKey } from '@/matching/taxonomy';
import type { DocConstraint } from '@/shared/types';

function ok<T>(data: T): Result<T> {
  return { ok: true, data };
}

function err(error: string, code?: string): Result<never> {
  return code === undefined ? { ok: false, error } : { ok: false, error, code };
}

/** Serialisable form of a derived file, for the message bus. */
export interface DerivedPayload {
  bytes: number[];
  mime: string;
  width: number;
  height: number;
  quality?: number;
  warnings: string[];
  fromCache: boolean;
  /** The stored master already fit, so it goes in exactly as it was saved. */
  passedThrough?: boolean;
}

/**
 * A portal-ready file for one document key, or a sentence saying why not.
 *
 * Bytes stay a `Uint8Array` here: this is the worker talking to itself. The
 * two callers serialise it for their own channel — the panel preview as
 * `number[]` (`doc:derive`, unchanged), a fill as base64 (`fill-service.ts`).
 */
export type VariantOutcome =
  | {
      ok: true;
      bytes: Uint8Array;
      mime: string;
      width: number;
      height: number;
      quality?: number;
      warnings: string[];
      fromCache: boolean;
      passedThrough: boolean;
    }
  | { ok: false; code: string; reason: string };

/**
 * A suggested value, with the piece of the document it was read from.
 *
 * `crop` is a small JPEG (base64) of that piece, present when the text was
 * recognised from pixels. It is the one thing on the suggestion screen the
 * reader did not produce: a misread digit is misread in the value *and* in the
 * quoted line, and only the picture shows what is actually printed. It stays
 * inside the extension — the panel is an extension page.
 */
export type ExtractedCandidate = Candidate & { crop?: string };

/** What the panel gets back from `doc:extract`. */
export interface DocumentExtraction {
  documentType: DocumentType;
  candidates: ExtractedCandidate[];
  /** Where the text came from, so the screen can say whether it is exact. */
  source: TextSource;
  scripts: string[];
  notes: string[];
  warnings: string[];
  /**
   * The text the reading actually produced.
   *
   * Shown on request, behind a disclosure. When recognition is imperfect — and
   * on a photograph it will be — a user who can see what was read can copy the
   * one value the rules missed, instead of being told only that nothing was
   * found. It never leaves the extension: the panel is an extension page, and
   * this crosses no network at any point.
   */
  text: string;
  /** The engine's own confidence, 0–1, when it offered one. */
  engineConfidence?: number;
}

/**
 * The optional OCR engine.
 *
 * Left null in this build. Reading a *photograph* needs a large dependency and
 * model data; reading a PDF's text layer needs neither and is exact, so the
 * feature is useful without one. `readAndExtract` degrades to a sentence
 * explaining that rather than an error — see `read-document.ts`.
 */
let ocrEngine: OcrEngine | null = null;

/** Install an engine. Called at most once, from the worker's own setup. */
export function setOcrEngine(engine: OcrEngine | null): void {
  ocrEngine = engine;
}

/**
 * Read a stored document and propose values from it.
 *
 * The bytes are decrypted here and **never leave this function** — the panel
 * receives extracted candidates, not the document. Nothing is written to the
 * vault: every candidate comes back `confirmed: false`, and the user decides
 * one at a time on the suggestion screen.
 */
/**
 * Reads already under way, by document.
 *
 * One press of "Read details from this" can arrive as two requests — React's
 * StrictMode runs the panel's effect twice in development — and reading a
 * bilingual card takes long enough that the two overlapped. The second asker
 * now shares the first one's answer instead of paying for the same read again.
 */
const readsUnderWay = new Map<string, Promise<DocumentExtraction>>();

function extractFrom(id: string): Promise<DocumentExtraction> {
  const existing = readsUnderWay.get(id);
  if (existing !== undefined) return existing;

  const reading = extractOnce(id).finally(() => readsUnderWay.delete(id));
  readsUnderWay.set(id, reading);
  return reading;
}

/** The widest a piece is shown: enough to read, small enough to send a dozen. */
const CROP_MAX_WIDTH = 720;

/**
 * The piece of the document each value was read from, as a small JPEG.
 *
 * Cut from the document as stored — not from whatever was handed to the reader
 * — so the user sees their own scan. Best effort throughout: a value with no
 * picture beside it is still a value, and a reading must never fail because a
 * crop did.
 */
async function evidenceCrops(
  bytes: Uint8Array,
  mime: string,
  candidates: readonly Candidate[],
  lines: readonly TextLine[] | undefined,
  turns: 0 | 1 | 2 | 3,
): Promise<Map<FieldKey, string>> {
  const crops = new Map<FieldKey, string>();
  if (lines === undefined || candidates.length === 0) return crops;

  try {
    const backend = createRasterBackend();
    if (backend.crop === undefined) return crops;

    const page =
      mime === 'application/pdf'
        ? await backend.rasterisePdf(bytes, 2000)
        : await backend.decode(bytes, mime);

    // Several values often come from one line; each piece is cut once.
    const cut = new Map<string, string>();
    for (const candidate of candidates) {
      // The line's place on the page as it was read — upright — carried back
      // onto the document as stored, which a sideways photograph still is.
      const upright = regionForLine(candidate.line, lines);
      if (upright === null) continue;
      const region = unturnBox(upright, turns);

      const name = `${region.x0},${region.y0},${region.x1},${region.y1}`;
      let jpeg = cut.get(name);
      if (jpeg === undefined) {
        const left = Math.floor(region.x0 * page.width);
        const top = Math.floor(region.y0 * page.height);
        const width = Math.max(1, Math.min(page.width - left, Math.ceil((region.x1 - region.x0) * page.width)));
        const height = Math.max(1, Math.min(page.height - top, Math.ceil((region.y1 - region.y0) * page.height)));

        const cutOut = await backend.crop(page, { left, top, width, height });
        // Cut sideways, shown upright: the user compares it with a value they
        // read the right way up.
        const piece =
          turns === 0 || backend.turn === undefined ? cutOut : await backend.turn(cutOut, turns);
        if (piece !== cutOut) backend.release?.(cutOut);
        const scale = Math.min(1, CROP_MAX_WIDTH / piece.width);
        const shown =
          scale === 1
            ? piece
            : await backend.resize(piece, {
                width: Math.round(piece.width * scale),
                height: Math.round(piece.height * scale),
                fit: 'contain',
                scale,
                exact: false,
              });
        jpeg = bytesToBase64(await backend.encodeJpeg(shown, 0.85));
        if (shown !== piece) backend.release?.(shown);
        backend.release?.(piece);
        cut.set(name, jpeg);
      }
      crops.set(candidate.key, jpeg);
    }

    backend.release?.(page);
  } catch {
    // No pictures, then — the values stand on their own.
  }
  return crops;
}

async function extractOnce(id: string): Promise<DocumentExtraction> {
  const document = await withKey((db, key) => getMaster(db, key, id));
  if (!document) throw new Error('That document is no longer in your vault.');

  const result = await readAndExtract(
    document.bytes,
    { mime: document.meta.mime },
    {
      pdfText: readPdfText,
      ...(ocrEngine === null ? {} : { ocr: ocrEngine }),
      // The slot the user filed it under: what tells a marks card whose marks
      // it carries. The vault has always known; it was simply never passed on.
      hint: { documentKey: document.key },
    },
  );

  const crops = await evidenceCrops(
    document.bytes,
    document.meta.mime,
    result.candidates,
    result.read.lines,
    result.read.turns ?? 0,
  );

  return {
    documentType: result.documentType,
    candidates: result.candidates.map((candidate) => {
      const crop = crops.get(candidate.key);
      return crop === undefined ? candidate : { ...candidate, crop };
    }),
    source: result.read.source,
    scripts: result.read.scripts,
    // How it was read, then what was read and deliberately not offered.
    notes: [...result.read.notes, ...result.notes],
    warnings: result.warnings,
    text: result.read.text,
    ...(result.read.engineConfidence === undefined
      ? {}
      : { engineConfidence: result.read.engineConfidence }),
  };
}

export async function handleDocumentRequest(
  request: DocumentRequest,
): Promise<Result<ResponseMap[DocumentRequest['type']]>> {
  try {
    switch (request.type) {
      case 'doc:list':
        if (!isUnlocked()) throw new VaultLockedError();
        return ok(await listMasters(await openVaultDb()));

      case 'doc:put': {
        const bytes = Uint8Array.from(request.bytes);
        /*
         * Measure the ink here, once, while the bytes are in hand.
         *
         * It has to be the worker rather than the panel: the panel never sees a
         * stored document again — the bytes are decrypted in this process and
         * stay in it — so a measurement taken anywhere else could not be
         * repeated later. Failure is expected and harmless (a PDF has no
         * bitmap, a blank scan has no ink), and `undefined` means every reader
         * falls back to judging by the canvas.
         */
        const shape = await measureShape(bytes, request.mime).catch(() => null);
        const summary = await withKey((db, key) =>
          putMaster(db, key, {
            key: request.key,
            label: request.label,
            bytes,
            meta: {
              mime: request.mime,
              bytes: bytes.length,
              width: request.width,
              height: request.height,
              capturedAt: new Date().toISOString(),
              ...(shape ? { content: shape.content } : {}),
            },
          }),
        );
        return ok(summary);
      }

      case 'doc:delete':
        if (!isUnlocked()) throw new VaultLockedError();
        await deleteMaster(await openVaultDb(), request.id);
        return ok(null);

      case 'doc:derive':
        return ok(await deriveFor(request.key, request.constraint));

      case 'doc:preflight':
        return ok(await preflight(request.key, request.constraint));

      case 'doc:extract':
        if (!isUnlocked()) throw new VaultLockedError();
        return ok(await extractFrom(request.id));
    }
  } catch (error) {
    if (error instanceof VaultLockedError) return err(error.message, 'VAULT_LOCKED');
    return err(error instanceof Error ? error.message : 'Unexpected document error.');
  }
}

/**
 * The panel's preview: the same variant a fill would attach, as `number[]`.
 *
 * Returns a failure *value* rather than throwing when the constraint cannot be
 * satisfied — that message is meant for the user, not the console.
 */
async function deriveFor(
  key: FieldKey,
  constraint: DocConstraint,
): Promise<DerivedPayload | { failed: true; reason: string; code: string }> {
  const outcome = await variantFor(key, constraint);
  if (!outcome.ok) return { failed: true, code: outcome.code, reason: outcome.reason };
  return {
    bytes: Array.from(outcome.bytes),
    mime: outcome.mime,
    width: outcome.width,
    height: outcome.height,
    ...(outcome.quality === undefined ? {} : { quality: outcome.quality }),
    warnings: outcome.warnings,
    fromCache: outcome.fromCache,
    ...(outcome.passedThrough ? { passedThrough: true } : {}),
  };
}

/**
 * Produce the file a document key should be attached as, for one constraint.
 *
 * In order: the master itself when it already fits (`canPassThrough`), a
 * cached variant, then a fresh derivation that is cached for next time. The
 * one function both the preview and the fill call, so what the user previewed
 * is byte-for-byte what a fill attaches.
 */
export async function variantFor(key: FieldKey, constraint: DocConstraint): Promise<VariantOutcome> {
  const db = await openVaultDb();

  return withKey(async (_db, cryptoKey): Promise<VariantOutcome> => {
    const master = await getMasterByKey(db, cryptoKey, key);
    if (!master) {
      return {
        ok: false,
        code: 'no-master',
        reason: `No ${key} has been added to your vault yet.`,
      };
    }

    if (canPassThrough(master.meta, constraint)) {
      return {
        ok: true,
        bytes: master.bytes,
        mime: master.meta.mime,
        width: master.meta.width,
        height: master.meta.height,
        warnings: [],
        fromCache: false,
        passedThrough: true,
      };
    }

    const cached = await getCachedVariant(db, cryptoKey, master.id, constraint);
    if (cached) {
      return {
        ok: true,
        bytes: cached.bytes,
        mime: cached.meta.mime,
        width: cached.meta.width,
        height: cached.meta.height,
        warnings: [],
        fromCache: true,
        passedThrough: false,
      };
    }

    /*
     * Two things the geometry cannot work out for itself.
     *
     * `content` is where the ink is, measured at upload — it lets the trim
     * remove blank paper before the target box is planned.
     *
     * `fit: 'pad'` for a signature overrides the centre-crop that a fixed
     * physical size implies. Centre-cropping a photograph trims the edges of a
     * face, which is a compromise; centre-cropping a signature removes the
     * ascender and the underline, which is a mutilation. A signature that does
     * not match the portal's box is letterboxed onto the page colour instead —
     * whole, and still recognisably the user's mark.
     */
    const role = roleFor(key);
    const result = await derive(createRasterBackend(), master.bytes, master.meta.mime, constraint, {
      // Never for a photograph (`trimsToInk`): its background is not margin.
      ...(master.meta.content && trimsToInk(role) ? { content: master.meta.content } : {}),
      ...(role === 'signature' ? { fit: 'pad' as const } : {}),
    });
    if (!result.ok) {
      return { ok: false, code: result.code, reason: result.reason };
    }

    await putVariant(db, cryptoKey, master.id, key, constraint, result.bytes, {
      mime: result.mime,
      bytes: result.bytes.length,
      width: result.width,
      height: result.height,
      capturedAt: new Date().toISOString(),
    });

    return fromDerivation(result);
  });
}

function fromDerivation(result: DerivedFile): VariantOutcome {
  return {
    ok: true,
    bytes: result.bytes,
    mime: result.mime,
    width: result.width,
    height: result.height,
    ...(result.quality === undefined ? {} : { quality: result.quality }),
    warnings: result.warnings.map((w) => w.message),
    fromCache: false,
    passedThrough: false,
  };
}

/**
 * Check whether a master *could* satisfy a constraint, without doing the work.
 *
 * This is the "quality gate" the plan asks for: it lets the UI warn at intake
 * ("this photo is too small for most portals") instead of at fill time, when
 * the user is mid-application and least able to go find a better scan.
 */
async function preflight(
  key: Parameters<typeof getMasterByKey>[2],
  constraint: DocConstraint,
): Promise<{ ok: boolean; warnings: string[]; reason?: string }> {
  const db = await openVaultDb();
  return withKey(async (_db, cryptoKey) => {
    const master = await getMasterByKey(db, cryptoKey, key);
    if (!master) {
      return { ok: false, warnings: [], reason: `No ${key} in your vault yet.` };
    }
    const source = { width: master.meta.width, height: master.meta.height };
    const box = planTargetBox(source, constraint);
    return { ok: true, warnings: inspectQuality(source, box).map((w) => w.message) };
  });
}
