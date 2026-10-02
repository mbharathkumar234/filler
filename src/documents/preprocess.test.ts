import { describe, expect, it } from 'vitest';

import { READ_LONG_EDGE, readerThreads, readingScale, tooSmallToRead } from './preprocess';

/**
 * How big a page is handed to the reader (§ reading a document).
 *
 * The reader takes a page as it was photographed; what is decided here is
 * size. Too big, and reading it outlives the worker waiting for it — which
 * happened, on a twelve-megapixel photograph of a PAN card. Too small, and the
 * honest answer is to say so.
 */

describe('how big a page is handed over', () => {
  it('shrinks a 12-megapixel photograph instead of handing over every pixel', () => {
    // The case that hung: 2944 x 4224 went through untouched, and reading it
    // outlived the worker that asked for it.
    const scale = readingScale(2944, 4224);
    expect(scale).toBeLessThan(1);
    expect(Math.round(4224 * scale)).toBe(READ_LONG_EDGE);
  });

  it('leaves a page that is already the right size alone', () => {
    expect(readingScale(1700, READ_LONG_EDGE)).toBe(1);
  });

  it('never hands over more pixels than the reader can read in a sitting', () => {
    for (const [w, h] of [
      [4000, 3000],
      [6000, 8000],
      [1200, 1600],
      [900, 700],
    ] as const) {
      const scale = Math.min(1, readingScale(w, h));
      expect(Math.round(w * scale) * Math.round(h * scale)).toBeLessThanOrEqual(6_000_000);
    }
  });

  it('would enlarge a small scan, which the reader declines to do', () => {
    // The answer points up; `ocr-host.ts` takes `Math.min(1, …)` of it,
    // because enlarging adds no detail the detector can use.
    expect(readingScale(904, 1280)).toBeGreaterThan(1);
  });
});

describe('telling the user the picture is too small', () => {
  it('says nothing about the certificates PaddleOCR read almost word for word', () => {
    // Measured in the Phase 0 comparison on the user's own 904 x 1280 caste
    // certificate and 820 x 1280 income certificate.
    expect(tooSmallToRead(904, 1280)).toBeNull();
    expect(tooSmallToRead(820, 1280)).toBeNull();
  });

  it('says so for a scan whose text cannot survive being read', () => {
    const note = tooSmallToRead(600, 800);
    expect(note).toMatch(/600/);
    expect(note).toMatch(/800/);
  });

  it('says nothing about a photograph that is big enough', () => {
    expect(tooSmallToRead(2400, 3200)).toBeNull();
  });
});

describe('how many CPU threads the reader uses', () => {
  /*
   * Measured on the user's five documents, back to back on one machine: four
   * threads read them in under half the time of one, with the same text and
   * the same fields. Threads share memory, and a page may only share memory
   * when the browser has isolated it from other origins — so the count is
   * decided from what the page was actually given, not from what was hoped.
   */
  it('uses one where memory cannot be shared, whatever the machine has', () => {
    expect(readerThreads(false, 16)).toBe(1);
  });

  it('uses half the machine, so the browser the user is sitting at stays usable', () => {
    expect(readerThreads(true, 4)).toBe(2);
    expect(readerThreads(true, 6)).toBe(3);
  });

  it('stops at four, past which the models gain little', () => {
    expect(readerThreads(true, 12)).toBe(4);
    expect(readerThreads(true, 64)).toBe(4);
  });

  it('uses one on a machine that has one to spare, or will not say', () => {
    expect(readerThreads(true, 2)).toBe(1);
    expect(readerThreads(true, 1)).toBe(1);
    expect(readerThreads(true, undefined)).toBe(1);
    expect(readerThreads(true, Number.NaN)).toBe(1);
  });
});
