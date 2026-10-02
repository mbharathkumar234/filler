/**
 * pdf.js's worker module, imported for its side effect: it sets
 * `globalThis.pdfjsWorker`, which pdf.js runs on the calling thread
 * (`documents/pdfjs.ts`). The package ships no types for it.
 */
declare module 'pdfjs-dist/build/pdf.worker.mjs';
