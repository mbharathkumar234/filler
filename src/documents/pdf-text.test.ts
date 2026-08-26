import { describe, expect, it } from 'vitest';

import { extractFromText } from './extract';
import { reconstructLines } from './pdf-text';

/**
 * Putting a PDF's lines back together (§ document extraction).
 *
 * `getTextContent` hands back positioned fragments, not lines, and every rule
 * in `extract.ts` is line-oriented — "does this line carry a date-of-birth
 * label". Get the grouping wrong and the exact-read path, which is the whole
 * advantage of a PDF over a photograph, produces one long unusable string.
 *
 * Coordinates below are PDF's: origin bottom-left, so a larger `y` is higher up
 * the page.
 */

const frag = (text: string, x: number, y: number, width = text.length * 5) => ({ text, x, y, width });

describe('grouping fragments into lines', () => {
  it('reads top to bottom, not in the order the file happens to store them', () => {
    const lines = reconstructLines([
      frag('third', 10, 100),
      frag('first', 10, 300),
      frag('second', 10, 200),
    ]);
    expect(lines).toEqual(['first', 'second', 'third']);
  });

  it('joins a label and its value on the same line', () => {
    // The case that matters: a two-column card layout. Concatenating without
    // grouping gives "NameRavi Kumar", and no label rule can read that.
    const lines = reconstructLines([
      frag('Name', 40, 300, 30),
      frag('Ravi Kumar', 200, 300),
      frag('DOB', 40, 280, 25),
      frag('14/03/1998', 200, 280),
    ]);
    expect(lines).toEqual(['Name Ravi Kumar', 'DOB 14/03/1998']);
  });

  it('does not merge two rows that are close together', () => {
    const lines = reconstructLines([frag('row one', 10, 100), frag('row two', 10, 94)]);
    expect(lines).toHaveLength(2);
  });

  it('treats a slight baseline drift as one line', () => {
    // Generated PDFs are not perfectly aligned; a fragment a point or two off
    // is still on the same visual line.
    const lines = reconstructLines([frag('Aadhaar', 10, 100, 40), frag('No', 55, 101.5, 15)]);
    expect(lines).toHaveLength(1);
  });

  it('orders fragments across a line by position, not arrival', () => {
    const lines = reconstructLines([
      frag('Kumar', 250, 300, 40),
      frag('Ravi', 200, 300, 40),
    ]);
    expect(lines).toEqual(['Ravi Kumar']);
  });

  it('does not insert a space where a word was merely split', () => {
    // pdf.js splits on kerning. `Ku` + `mar` with no gap is one word, and
    // "Ku mar" would break every name comparison downstream.
    const lines = reconstructLines([frag('Ku', 200, 300, 12), frag('mar', 212, 300, 18)]);
    expect(lines).toEqual(['Kumar']);
  });

  it('drops empty lines rather than emitting blanks', () => {
    expect(reconstructLines([frag('  ', 10, 100), frag('real', 10, 80)])).toEqual(['real']);
  });

  it('returns nothing for a page with no text at all', () => {
    // A scanned PDF. The caller then falls through to OCR.
    expect(reconstructLines([])).toEqual([]);
  });

  it('survives fragments with no width information', () => {
    const lines = reconstructLines([
      { text: 'A', x: 10, y: 100, width: 0 },
      { text: 'B', x: 60, y: 100, width: 0 },
    ]);
    expect(lines).toEqual(['A B']);
  });
});

describe('a realistic card, reassembled', () => {
  it('produces lines the extractor can actually read', () => {
    const lines = reconstructLines([
      frag('Government of India', 40, 400),
      frag('Ravi Kumar', 40, 360),
      frag('DOB', 40, 340, 25),
      frag(':', 70, 340, 4),
      frag('14/03/1998', 80, 340),
      frag('MALE', 40, 320, 30),
      frag('9999', 40, 280, 30),
      frag('9999', 75, 280, 30),
      frag('0019', 110, 280, 30),
    ]);

    expect(lines).toEqual([
      'Government of India',
      'Ravi Kumar',
      // A real gap between the label and its colon becomes a real space. That
      // is faithful to the page, and the extractor is label-*matching* rather
      // than string-comparing, so it reads either form — asserted below.
      'DOB : 14/03/1998',
      'MALE',
      '9999 9999 0019',
    ]);
  });

  it('hands the extractor lines it can actually read', () => {
    // The end-to-end point of this module. Reconstruction is only correct if
    // what comes out the other side is usable, whatever the spacing.
    const lines = reconstructLines([
      frag('Government of India', 40, 400),
      frag('Ravi Kumar', 40, 360),
      frag('DOB', 40, 340, 25),
      frag(':', 70, 340, 4),
      frag('14/03/1998', 80, 340),
      frag('MALE', 40, 320, 30),
      frag('9999', 40, 280, 30),
      frag('9999', 75, 280, 30),
      frag('0019', 110, 280, 30),
      // Every e-Aadhaar prints this. Without it the number is still read, but
      // as an unidentified twelve-digit value rather than an Aadhaar number —
      // which is the correct, more cautious reading of a document that never
      // says what it is.
      frag('आधार - आम आदमी का अधिकार', 40, 240),
    ]);

    const extracted = extractFromText(lines.join('\n'));
    expect(extracted.documentType).toBe('aadhaar');
    expect(extracted.candidates.find((c) => c.key === 'identity.dob')?.value).toBe('1998-03-14');
    expect(extracted.candidates.find((c) => c.key === 'id.aadhaar')?.value).toBe('999999990019');
    expect(extracted.candidates.find((c) => c.key === 'identity.gender')?.value).toBe('Male');
  });
});
