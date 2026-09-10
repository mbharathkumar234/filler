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
import { roleFor } from '@/documents/intake';
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
import { readAndExtract, type OcrEngine } from '@/documents/read-document';
import { readPdfText } from '@/documents/pdf-text';
import type { Candidate, DocumentType } from '@/documents/extract';
import type { TextSource } from '@/documents/read-document';
import { VaultLockedError, isUnlocked, withKey } from '@/vault/session';
import { inspectQuality, planTargetBox } from '@/documents/geometry';
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
}

/** What the panel gets back from `doc:extract`. */
export interface DocumentExtraction {
  documentType: DocumentType;
  candidates: Candidate[];
  /** Where the text came from, so the screen can say whether it is exact. */
  source: TextSource;
  scripts: string[];
  notes: string[];
  warnings: string[];
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
async function extractFrom(id: string): Promise<DocumentExtraction> {
  const document = await withKey((db, key) => getMaster(db, key, id));
  if (!document) throw new Error('That document is no longer in your vault.');

  const result = await readAndExtract(
    document.bytes,
    { mime: document.meta.mime },
    { pdfText: readPdfText, ...(ocrEngine === null ? {} : { ocr: ocrEngine }) },
  );

  return {
    documentType: result.documentType,
    candidates: result.candidates,
    source: result.read.source,
    scripts: result.read.scripts,
    notes: result.read.notes,
    warnings: result.warnings,
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
 * Produce a variant for a taxonomy key, using the cache when possible.
 *
 * Returns a failure *value* rather than throwing when the constraint cannot be
 * satisfied — that message is meant for the user, not the console.
 */
async function deriveFor(
  key: Parameters<typeof getMasterByKey>[2],
  constraint: DocConstraint,
): Promise<DerivedPayload | { failed: true; reason: string; code: string }> {
  const db = await openVaultDb();

  return withKey(async (_db, cryptoKey) => {
    const master = await getMasterByKey(db, cryptoKey, key);
    if (!master) {
      return {
        failed: true as const,
        code: 'no-master',
        reason: `No ${key} has been added to your vault yet.`,
      };
    }

    const cached = await getCachedVariant(db, cryptoKey, master.id, constraint);
    if (cached) {
      return {
        bytes: Array.from(cached.bytes),
        mime: cached.meta.mime,
        width: cached.meta.width,
        height: cached.meta.height,
        warnings: [],
        fromCache: true,
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
    const result = await derive(createRasterBackend(), master.bytes, master.meta.mime, constraint, {
      ...(master.meta.content ? { content: master.meta.content } : {}),
      ...(roleFor(key) === 'signature' ? { fit: 'pad' as const } : {}),
    });
    if (!result.ok) {
      return { failed: true as const, code: result.code, reason: result.reason };
    }

    await putVariant(db, cryptoKey, master.id, key, constraint, result.bytes, {
      mime: result.mime,
      bytes: result.bytes.length,
      width: result.width,
      height: result.height,
      capturedAt: new Date().toISOString(),
    });

    return toPayload(result);
  });
}

function toPayload(result: DerivedFile): DerivedPayload {
  return {
    bytes: Array.from(result.bytes),
    mime: result.mime,
    width: result.width,
    height: result.height,
    ...(result.quality === undefined ? {} : { quality: result.quality }),
    warnings: result.warnings.map((w) => w.message),
    fromCache: false,
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
