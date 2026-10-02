import { describe, expect, it } from 'vitest';

import { READABLE_SCRIPTS, readableWithBundled } from './ocr';

/**
 * Which scripts this build reads (§ reading a document).
 *
 * PaddleOCR's English recogniser, and nothing else: the Phase 0 comparison on
 * the user's own documents found every value the vault needs printed in
 * English, and PaddleOCR's only Kannada model reading worse than none. The
 * build says exactly what it can read, so a document in another script gets an
 * honest sentence rather than a confident misreading.
 */
describe('the scripts this build reads', () => {
  it('reads the Latin script, and claims nothing more', () => {
    expect([...READABLE_SCRIPTS]).toEqual(['Latin']);
    expect(readableWithBundled()).toEqual(['Latin']);
  });

  it('hands out a copy, so nobody can widen the claim by accident', () => {
    readableWithBundled().push('Kannada');
    expect(readableWithBundled()).toEqual(['Latin']);
  });
});
