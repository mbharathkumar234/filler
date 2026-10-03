import { describe, expect, it } from 'vitest';

import { READABLE_SCRIPTS, readableWithBundled } from './ocr';

/**
 * Which scripts this build reads (§ reading a document).
 *
 * PaddleOCR's English recogniser, and its recognisers for Devanagari, Telugu
 * and Tamil — the Indian scripts it has a light model for — and nothing else:
 * its only Kannada model reads worse than none, and it has no light model for
 * Bengali, Gujarati, Gurmukhi, Odia or Malayalam. The build says exactly what
 * it can read, so a document in another script gets an honest sentence rather
 * than a confident misreading.
 */
describe('the scripts this build reads', () => {
  it('reads English, Devanagari, Telugu and Tamil, and claims nothing more', () => {
    expect([...READABLE_SCRIPTS]).toEqual(['Latin', 'Devanagari', 'Telugu', 'Tamil']);
    expect(readableWithBundled()).toEqual(['Latin', 'Devanagari', 'Telugu', 'Tamil']);
  });

  it('does not claim Kannada, which no model this build has reads well', () => {
    expect(READABLE_SCRIPTS).not.toContain('Kannada');
  });

  it('hands out a copy, so nobody can widen the claim by accident', () => {
    readableWithBundled().push('Kannada');
    expect(readableWithBundled()).not.toContain('Kannada');
  });
});
