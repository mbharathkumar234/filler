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

import { isEnvelope, type ExtensionRequest, type OcrItem } from '@/shared/messages';
import { base64ToBytes } from '@/shared/base64';
import type { ReadRequest, ReadResponse } from './reader-worker';

type PageReading = { items: OcrItem[]; width: number; height: number; turns: 0 | 1 | 2 | 3 };

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, { resolve: (r: PageReading) => void; reject: (e: Error) => void }>();

/** The reader, started on first use and kept for as long as this page lives. */
function reader(): Worker {
  if (worker !== null) return worker;

  worker = new Worker(new URL('./reader-worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (event: MessageEvent<ReadResponse>) => {
    const answer = event.data;
    const waiting = pending.get(answer.id);
    if (waiting === undefined) return;
    pending.delete(answer.id);
    if (answer.ok) waiting.resolve(answer.result);
    else waiting.reject(new Error(answer.error));
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

function recognise(image: string, mime: string): Promise<PageReading> {
  const bytes = base64ToBytes(image);
  // A copy the worker can own outright, handed over rather than cloned.
  const buffer = bytes.slice().buffer;
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    const request: ReadRequest = { id, image: buffer, mime, base: chrome.runtime.getURL('ocr/') };
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

function recogniseInTurn(image: string, mime: string) {
  const mine = queue.then(() => recognise(image, mime));
  queue = mine.then(
    () => undefined,
    () => undefined,
  );
  return mine;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!isEnvelope(message)) return false;
  if (sender.id !== chrome.runtime.id) return false;

  const request = message.payload as ExtensionRequest;
  if (request.type !== 'ocr:recognise') return false;

  recogniseInTurn(request.image, request.mime).then(
    (result) => sendResponse({ ok: true, data: result }),
    (error: unknown) =>
      sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : 'The document could not be read.',
      }),
  );
  return true;
});
