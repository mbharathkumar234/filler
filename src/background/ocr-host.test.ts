import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * That the reader is actually plugged in (§ reading a document).
 *
 * `setOcrEngine` sat in `document-service.ts` with **no caller at all** from
 * Phase 2 until now, so every photograph came back "reading text from
 * photographs is not available in this build" — a seam, a sentence explaining
 * its absence, and nothing in between. The same shape has bitten twice since
 * (a message the router never routed, a guard nothing engaged), and it is
 * invisible to every unit test of the parts.
 *
 * So this one reads the wiring itself.
 */
describe('the document reader is installed', () => {
  const worker = readFileSync('src/background/index.ts', 'utf8');

  it('is handed to the document service when the worker starts', () => {
    expect(worker).toContain('setOcrEngine(createOcrHost())');
  });

  it('is installed at the top level, not inside a listener that may never fire', () => {
    const line = worker
      .split(/\r?\n/)
      .find((text) => text.includes('setOcrEngine(createOcrHost())'));
    expect(line, 'setOcrEngine is missing').toBeDefined();
    // No leading whitespace: inside `onInstalled` it would never run for a
    // browser that simply started up with the extension already installed.
    expect(line).toBe('setOcrEngine(createOcrHost());');
  });

  it('answers the worker’s message for the reader to no one else', () => {
    // The worker hears every extension message, including this one, which is
    // addressed to the offscreen reader. Replying on its behalf is how the
    // reader's answer got thrown away.
    expect(worker).toContain('if (OFFSCREEN_TYPES.has(message.payload.type)) return false;');
  });
});

/**
 * The reading that outlived the worker waiting for it (§ reading a document).
 *
 * A 2944 x 4224 photograph of a PAN card — 12.4 megapixels — was handed to the
 * engine untouched, because the sizing step only ever scaled pictures *up*.
 * Recognising it took longer than MV3 lets an idle service worker live, the
 * worker was collected, and the panel showed the browser's own words for a
 * promise nobody would ever keep: "A listener indicated an asynchronous
 * response by returning true, but the message channel closed before a response
 * was received."
 *
 * Three things fix it, and each is asserted here against the source, because
 * each is invisible in a unit test of the parts and each would fail the same
 * silent way.
 */
describe('a reading that takes a long time', () => {
  const host = readFileSync('src/background/ocr-host.ts', 'utf8');

  it('shrinks a huge photograph, and never enlarges a small one', () => {
    expect(host).toContain('Math.min(1, readingScale(source.width, source.height))');
  });

  it('keeps the worker alive while the engine is reading', () => {
    expect(host).toContain('keepAlive()');
    expect(host).toContain('getPlatformInfo');
    // Started before the request and stopped in a `finally`, or a failed read
    // leaves a timer pinging forever.
    expect(host).toMatch(/finally \{\s*\n\s*stopPinging\(\);/);
  });

  it('gives up in its own words rather than waiting forever', () => {
    expect(host).toContain('READ_TIMEOUT_MS');
    expect(host).toContain('took too long and was stopped');
  });

  it('hands the reader the image as it was stored, when it is not too big', () => {
    // PaddleOCR's models were trained on photographs. Every re-encode, and
    // every "clean-up" — the lighting-flattening pass that suited Tesseract —
    // costs them detail they use; the Phase 0 comparison fed them untouched
    // images and read 114 of 120 phrases.
    expect(host).toContain('return { image: bytes, mime, notes }');
    expect(host).not.toContain('prepareForReading');
  });
});

/**
 * One reader, English only (§ reading a document).
 *
 * The two-pass reading — English, then again with Kannada, merged — was built
 * for Tesseract and is gone with it. PaddleOCR's detector puts each word in its
 * own box, and a box the English model can only guess at is dropped by score
 * (`layout.ts`); the Phase 0 comparison found no field on the user's documents
 * that needed the Kannada reading.
 */
describe('what the reader reads', () => {
  const host = readFileSync('src/background/ocr-host.ts', 'utf8');

  it('reads one pass, and makes no second reading in another alphabet', () => {
    expect(host).not.toMatch(/readWrongAlphabet|mergeReadings|betterReading/);
    expect(host).toContain("if (!scripts.includes('Latin')) return { text: '' }");
  });

  it('puts the boxes back into lines before the field rules see them', () => {
    expect(host).toContain('layoutLines(reading.items)');
  });
});
