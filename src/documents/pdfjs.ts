/**
 * pdf.js, with its worker's code running on the calling thread (§ documents).
 *
 * pdf.js does its parsing in a "worker", and it finds that worker one of two
 * ways: a script it can start from `GlobalWorkerOptions.workerSrc`, or code
 * already loaded on this thread at `globalThis.pdfjsWorker`. A separate worker
 * script is awkward under the extension's `script-src 'self'`, so the choice
 * made long ago was the second — but only half of it was made: `workerSrc` was
 * emptied and the worker's code was never loaded. Every `getDocument` therefore
 * rejected with "No GlobalWorkerOptions.workerSrc specified", in the service
 * worker as anywhere else: no PDF's text was ever read, and no PDF could be
 * turned into the copy a portal wants. Nothing tested a real PDF, so nothing
 * noticed — until the locked-PDF tests opened one (`e2e/pdf-lock.spec.ts`).
 *
 * Importing the worker module sets `globalThis.pdfjsWorker`, and pdf.js then
 * runs it in-thread wherever it is called. Both are loaded only when a PDF is
 * actually involved, and both are files of this package; `verify-dist.mjs`
 * fails a build that leaves the worker out.
 *
 * Never in the service worker: `import()` is disallowed there by the HTML
 * specification, so the worker hands its PDFs to the offscreen page, which
 * calls this (`background/ocr-host.ts` → `offscreenPdf`).
 */

import type * as PdfJsModule from 'pdfjs-dist';

type PdfJs = typeof PdfJsModule;

let loading: Promise<PdfJs> | null = null;

export function loadPdfJs(): Promise<PdfJs> {
  loading ??= Promise.all([
    import('pdfjs-dist'),
    import('pdfjs-dist/build/pdf.worker.mjs'),
  ]).then(([pdfjs]) => pdfjs);
  // A failed load is not kept: the next PDF tries again.
  loading.catch(() => {
    loading = null;
  });
  return loading;
}
