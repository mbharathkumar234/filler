/**
 * The document reader's page (§ reading a document).
 *
 * An offscreen document, which exists for one reason: the reader runs in a
 * dedicated Web Worker (`reader-worker.ts`), and a service worker cannot start
 * one. This page starts it, relays each reading the service worker asks for,
 * and hands back what it found. It has no UI, is never in a tab, and is closed
 * by the service worker when the last reading is done — which ends the worker
 * with it, so nothing of the user's document stays resident.
 *
 * **Everything the reader loads is inside the package.** PaddleOCR's own SDK
 * downloads its models from Baidu's model host on first use and falls back to a
 * CDN for its runtime; it is not used at all (its OpenCV.js needs
 * `new Function`, which the extension's CSP forbids). The models come from this
 * extension's own origin, ONNX Runtime's WebAssembly is a build asset of this
 * package, and the CSP (`connect-src 'self'`) refuses anything else.
 */

import {
  OFFSCREEN_TYPES,
  isEnvelope,
  isPrivilegedSender,
  type ExtensionRequest,
  type OcrItem,
  type PdfRequest,
  type ResponseMap,
} from '@/shared/messages';
import { validateRequest } from '@/shared/validate';
import { base64ToBytes, bytesToBase64 } from '@/shared/base64';
import { lockFromError, pdfLock } from '@/documents/pdf-lock';
import { readPdfText } from '@/documents/pdf-text';
import { createRasterBackend, renderPdfPage } from '@/documents/raster';
import type { IndicScript } from '@/documents/indic';
import type { ReadTable } from '@/documents/table';
import type { ReadSeal } from '@/documents/paddle-reader';
import type { ReadRequest, ReadResponse } from './reader-worker';

/** The worker's reading, with a flattened page carried as base64: the bus is JSON. */
type PageReading = {
  items: OcrItem[];
  width: number;
  height: number;
  turns: 0 | 1 | 2 | 3;
  flattened?: string;
  tables?: ReadTable[];
  seals?: ReadSeal[];
};

/** A clean scan, carried as base64. */
type ScanReading = { image: string; width: number; height: number; flattened: boolean; turns: 0 | 1 | 2 | 3 };

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, { resolve: (r: PageReading | ScanReading) => void; reject: (e: Error) => void }>();

/** The reader, started on first use and kept for as long as this page lives. */
function reader(): Worker {
  if (worker !== null) return worker;

  worker = new Worker(new URL('./reader-worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (event: MessageEvent<ReadResponse>) => {
    const answer = event.data;
    const waiting = pending.get(answer.id);
    if (waiting === undefined) return;
    pending.delete(answer.id);
    if (!answer.ok) {
      waiting.reject(new Error(answer.error));
    } else if ('scan' in answer) {
      waiting.resolve({ ...answer.scan, image: bytesToBase64(new Uint8Array(answer.scan.image)) });
    } else {
      const { flattened, ...reading } = answer.result;
      waiting.resolve(
        flattened === undefined ? reading : { ...reading, flattened: bytesToBase64(new Uint8Array(flattened)) },
      );
    }
  };
  worker.onerror = (event) => {
    // A reader that fell over takes every reading in hand with it, and the
    // next reading starts a fresh one rather than inheriting a broken one.
    const error = new Error(event.message || 'The document reader stopped unexpectedly.');
    for (const waiting of pending.values()) waiting.reject(error);
    pending.clear();
    worker?.terminate();
    worker = null;
  };
  return worker;
}

/** A stored photo made a clean scan by the reader's worker. */
function scanPage(image: string, mime: string): Promise<ScanReading> {
  const buffer = base64ToBytes(image).slice().buffer;
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve: resolve as (r: PageReading | ScanReading) => void, reject });
    const request: ReadRequest = { id, image: buffer, mime, base: chrome.runtime.getURL('ocr/'), kind: 'scan' };
    reader().postMessage(request, [buffer]);
  });
}

function recognise(image: string, mime: string, scripts: readonly IndicScript[] = []): Promise<PageReading> {
  const bytes = base64ToBytes(image);
  // A copy the worker can own outright, handed over rather than cloned.
  const buffer = bytes.slice().buffer;
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve: resolve as (r: PageReading | ScanReading) => void, reject });
    const request: ReadRequest = {
      id,
      image: buffer,
      mime,
      base: chrome.runtime.getURL('ocr/'),
      scripts: [...scripts],
    };
    reader().postMessage(request, [buffer]);
  });
}

/**
 * One reading at a time.
 *
 * One reading already uses the threads the machine can spare, so two at once
 * only make each other slower; one at a time also means no reading ever shares
 * a session mid-run. The queue never rejects, or one failed reading would
 * silently skip every reading after it.
 */
let queue: Promise<void> = Promise.resolve();

function inTurn<T>(job: () => Promise<T>): Promise<T> {
  const mine = queue.then(job);
  queue = mine.then(
    () => undefined,
    () => undefined,
  );
  return mine;
}

// ---------------------------------------------------------------------------
// PDFs
// ---------------------------------------------------------------------------

/**
 * Open a PDF for the service worker, which cannot (`documents/pdfjs.ts`).
 *
 * pdf.js runs here, on this page's own thread: it was made for a page, with a
 * document to make canvases from and fonts to load into, and a worker has
 * neither. The bytes and the password arrive with the request and are dropped
 * with it.
 */
async function openPdf<T extends PdfRequest['type']>(
  request: Extract<PdfRequest, { type: T }>,
): Promise<ResponseMap[T]>;
async function openPdf(request: PdfRequest): Promise<ResponseMap[PdfRequest['type']]> {
  const bytes = base64ToBytes(request.pdf);
  switch (request.type) {
    case 'pdf:lock':
      return { lock: await pdfLock(bytes, request.password) };
    case 'pdf:text':
      return { text: await readPdfText(bytes, request.password) };
    case 'pdf:render': {
      const backend = createRasterBackend();
      const { source: page, pages } = await renderPdfPage(
        bytes,
        request.width,
        request.password,
        request.page ?? 1,
      );
      try {
        const png = await backend.encodePng(page);
        return { image: bytesToBase64(png), width: page.width, height: page.height, pages };
      } finally {
        backend.release?.(page);
      }
    }
  }
}

/** What went wrong with a PDF, in words the person who saved it can act on. */
function pdfFailure(error: unknown): string {
  switch (lockFromError(error)) {
    case 'needs-password':
      // A locked PDF saved before the vault asked for passwords.
      return 'This PDF is locked with a password the vault does not have. Save it again, and it will ask you for the password.';
    case 'wrong-password':
      return 'The password kept with this PDF no longer opens it. Save it again with the right password.';
    default:
      return error instanceof Error ? error.message : 'The PDF could not be opened.';
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!isEnvelope(message)) return false;
  const request = message.payload as ExtensionRequest;
  if (!OFFSCREEN_TYPES.has(request.type)) return false;

  // The worker leaves these to this page, so this page applies the worker's
  // rules: from this extension, from an extension page — never from a content
  // script, which carries a tab — and shaped as the type says.
  if (!isPrivilegedSender(sender) || !validateRequest(request).ok) {
    sendResponse({ ok: false, error: 'Rejected.' });
    return true;
  }

  const answer = (job: Promise<unknown>, failure: (error: unknown) => string) => {
    job.then(
      (data) => sendResponse({ ok: true, data }),
      (error: unknown) => sendResponse({ ok: false, error: failure(error) }),
    );
    return true;
  };

  if (request.type === 'ocr:recognise') {
    return answer(inTurn(() => recognise(request.image, request.mime, request.scripts)), (error) =>
      error instanceof Error ? error.message : 'The document could not be read.',
    );
  }
  if (request.type === 'ocr:scan') {
    return answer(inTurn(() => scanPage(request.image, request.mime)), (error) =>
      error instanceof Error ? error.message : 'The photo could not be made a scan.',
    );
  }
  if (request.type === 'pdf:lock' || request.type === 'pdf:text' || request.type === 'pdf:render') {
    return answer(inTurn(() => openPdf(request)), pdfFailure);
  }
  return false;
});
