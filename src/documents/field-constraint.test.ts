import { describe, expect, it } from 'vitest';
import type { DocConstraint } from '@/shared/types';
import { acceptedMimes, canPassThrough, constraintForField, fileNameFor } from './field-constraint';

/**
 * Which requirement one upload box on a live page means.
 *
 * The Phase 2 pipeline can satisfy any `DocConstraint`; these tests pin down
 * how a constraint is *chosen* for a field — from a taught profile, from the
 * page's own words, from the box's `accept` list — and when the stored master
 * can go in untouched.
 */

const KB = 1024;
const MB = 1024 * KB;

describe('acceptedMimes reads the accept attribute', () => {
  it('reads MIME types and extensions alike', () => {
    expect(acceptedMimes('image/jpeg')).toEqual(['image/jpeg']);
    expect(acceptedMimes('.jpg,.jpeg')).toEqual(['image/jpeg']);
    expect(acceptedMimes('.pdf')).toEqual(['application/pdf']);
    expect(acceptedMimes('image/png, application/pdf')).toEqual(['image/png', 'application/pdf']);
  });

  it('expands an image wildcard to the image formats we can make', () => {
    expect(acceptedMimes('image/*')).toEqual(['image/jpeg', 'image/png']);
  });

  it('treats the historical JPEG spellings as JPEG', () => {
    expect(acceptedMimes('image/jpg')).toEqual(['image/jpeg']);
    expect(acceptedMimes('image/pjpeg')).toEqual(['image/jpeg']);
    expect(acceptedMimes('.JFIF')).toEqual(['image/jpeg']);
  });

  it('means "anything" for an absent, empty or match-all list', () => {
    expect(acceptedMimes(undefined)).toEqual([]);
    expect(acceptedMimes('')).toEqual([]);
    expect(acceptedMimes('*/*')).toEqual([]);
  });

  it('ignores types we could never produce rather than guessing', () => {
    expect(acceptedMimes('.doc,.docx')).toEqual([]);
    expect(acceptedMimes('.gif,.jpg')).toEqual(['image/jpeg']);
  });
});

describe('constraintForField', () => {
  it('reads the requirement from the label when the portal put it there', () => {
    const { constraint, source } = constraintForField({
      labelText: 'Upload Photograph (JPEG, 20 KB to 50 KB, 3.5 cm x 4.5 cm)',
    });
    expect(source).toBe('page');
    expect(constraint).toMatchObject({
      mime: ['image/jpeg'],
      minBytes: 20 * KB,
      maxBytes: 50 * KB,
      dimensionsMm: [35, 45],
    });
  });

  it('reads the hint beside the box as well as the label', () => {
    const { constraint } = constraintForField({
      labelText: 'Upload your 10th marks card',
      requirementText: 'Upload 1 supported file: PDF. Max 10 MB.',
    });
    expect(constraint.mime).toEqual(['application/pdf']);
    expect(constraint.maxBytes).toBe(10 * MB);
  });

  it('narrows the stated formats by what the box accepts', () => {
    const { constraint } = constraintForField({
      labelText: 'Photo',
      requirementText: 'JPG or PDF, below 100 KB',
      accept: '.jpg,.jpeg',
    });
    expect(constraint.mime).toEqual(['image/jpeg']);
    expect(constraint.maxBytes).toBe(100 * KB);
  });

  it('takes the format from accept when the words say nothing about it', () => {
    const { constraint, source } = constraintForField({ labelText: 'Signature', accept: 'image/jpeg' });
    expect(constraint.mime).toEqual(['image/jpeg']);
    expect(source).toBe('page');
  });

  it('trusts the box itself when its accept list and the prose disagree', () => {
    // A hint shared by several boxes can mention a format this one refuses.
    const { constraint } = constraintForField({
      labelText: 'Caste certificate',
      requirementText: 'Photographs in JPEG.',
      accept: 'application/pdf',
    });
    expect(constraint.mime).toEqual(['application/pdf']);
  });

  it('adds nothing when the page states nothing, rather than guessing', () => {
    const { constraint, source } = constraintForField({ labelText: 'Upload your PAN card copy' });
    expect(constraint).toEqual({ mime: [] });
    expect(source).toBe('none');
  });

  it('uses a taught constraint outright, whatever the page says', () => {
    const taught: DocConstraint = { mime: ['image/png'], maxBytes: 30 * KB };
    const { constraint, source } = constraintForField({
      labelText: 'Photo (JPEG, max 50 KB)',
      accept: '.jpg',
      taught,
    });
    expect(source).toBe('taught');
    expect(constraint).toEqual(taught);
  });

  it('says what it read, for the panel to show', () => {
    const { matched } = constraintForField({
      labelText: 'Signature',
      requirementText: 'JPEG, 10 KB to 20 KB',
    });
    expect(matched.join(' ')).toMatch(/JPEG/);
    expect(matched.join(' ')).toMatch(/10 KB/);
  });
});

describe('canPassThrough', () => {
  const jpeg = { mime: 'image/jpeg', bytes: 40 * KB, width: 413, height: 531 };
  const pdf = { mime: 'application/pdf', bytes: 300 * KB, width: 0, height: 0 };

  it('lets a master that already fits go in untouched', () => {
    expect(canPassThrough(jpeg, { mime: ['image/jpeg'], minBytes: 20 * KB, maxBytes: 50 * KB })).toBe(true);
    expect(canPassThrough(pdf, { mime: ['application/pdf'], maxBytes: 2 * MB })).toBe(true);
  });

  it('passes anything when nothing is asked', () => {
    expect(canPassThrough(jpeg, { mime: [] })).toBe(true);
    expect(canPassThrough(pdf, { mime: [] })).toBe(true);
  });

  it('never hands a portal a locked PDF as it is, however well it fits', () => {
    // Whoever opens it on the portal's side has no password. The copy made
    // from it, with the password the vault keeps, is an ordinary file.
    const locked = { ...pdf, locked: true as const };
    expect(canPassThrough(locked, { mime: ['application/pdf'], maxBytes: 2 * MB })).toBe(false);
    expect(canPassThrough(locked, { mime: [] })).toBe(false);
  });

  it('refuses a format the box does not take', () => {
    expect(canPassThrough(pdf, { mime: ['image/jpeg'] })).toBe(false);
  });

  it('refuses a file outside the byte window, in either direction', () => {
    expect(canPassThrough(jpeg, { mime: [], maxBytes: 30 * KB })).toBe(false);
    expect(canPassThrough(jpeg, { mime: [], minBytes: 50 * KB })).toBe(false);
  });

  it('never passes when a physical size is asked, because that needs planning', () => {
    expect(canPassThrough(jpeg, { mime: ['image/jpeg'], dimensionsMm: [35, 45] })).toBe(false);
    expect(canPassThrough(jpeg, { mime: ['image/jpeg'], aspect: 35 / 45 })).toBe(false);
    expect(canPassThrough(jpeg, { mime: ['image/jpeg'], dpi: 200 })).toBe(false);
  });

  it('checks pixel bounds against the measured size', () => {
    expect(canPassThrough(jpeg, { mime: [], minW: 400, minH: 500 })).toBe(true);
    expect(canPassThrough(jpeg, { mime: [], maxW: 300, maxH: 300 })).toBe(false);
  });

  it('never passes pixel bounds for a file that was never measured', () => {
    // A PDF has no bitmap, so width and height are zero — not "small".
    expect(canPassThrough(pdf, { mime: [], maxW: 2000, maxH: 2000 })).toBe(false);
  });

  it('never passes a format the pipeline cannot vouch for', () => {
    const heic = { mime: 'image/heic', bytes: 900 * KB, width: 3024, height: 4032 };
    expect(canPassThrough(heic, { mime: [] })).toBe(false);
  });
});

describe('fileNameFor', () => {
  it('names the file after the document, never after the person', () => {
    expect(fileNameFor('doc.photo', 'image/jpeg')).toBe('photo.jpg');
    expect(fileNameFor('doc.aadhaar_card', 'application/pdf')).toBe('aadhaar_card.pdf');
    expect(fileNameFor('doc.signature', 'image/png')).toBe('signature.png');
  });

  it('keeps the extension honest for anything else', () => {
    expect(fileNameFor('doc.marksheet_10', 'application/octet-stream')).toBe('marksheet_10.bin');
  });
});
