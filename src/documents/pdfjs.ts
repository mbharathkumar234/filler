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

/**
 * Where pdf.js finds the decoders for the images scanners write: `pdfjs/` in
 * this package (`vite.config.ts` → `pdfjsDecoders`).
 *
 * A black-and-white scan is usually stored as CCITT fax or JBIG2, both decoded
 * by `jbig2.wasm`; JPEG 2000 by `openjpeg.wasm`; embedded colour profiles by
 * `qcms_bg.wasm`. Without them pdf.js draws such an image as nothing, and a
 * scanned page reads as blank. Outside the extension — a test page — there is
 * no package to point at, and pdf.js goes without.
 */
function decoderBase(): string | undefined {
  try {
    return typeof chrome !== 'undefined' && typeof chrome.runtime?.getURL === 'function'
      ? chrome.runtime.getURL('pdfjs/')
      : undefined;
  } catch {
    return undefined;
  }
}

/** Open a PDF — with `password`, if it is locked — the one way every caller does. */
export async function openPdf(
  bytes: Uint8Array,
  password?: string,
): Promise<ReturnType<PdfJs['getDocument']>> {
  const { getDocument, VerbosityLevel } = await loadPdfJs();
  const wasmUrl = decoderBase();
  return getDocument({
    // A copy: pdf.js takes ownership of the buffer it is handed.
    data: new Uint8Array(bytes),
    // Errors only. pdf.js warns "Setting up fake worker." on every PDF — the
    // in-thread worker this file sets up on purpose — and about every oddity of
    // a scanner's file; Chrome listed each under the extension's Errors. A PDF
    // that cannot be opened or drawn still throws, and the panel says so.
    verbosity: VerbosityLevel.ERRORS,
    ...(password === undefined ? {} : { password }),
    ...(wasmUrl === undefined ? {} : { wasmUrl }),
  });
}
