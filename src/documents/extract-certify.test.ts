import { describe, expect, it } from 'vitest';

import { extractFromText } from './extract';

/**
 * "This is to certify that …" (§ reading a document).
 *
 * The CBSE statement prints the student's name with no label at all, as the
 * rest of the line "This is to certify that". Karnataka's Nadakacheri
 * certificates go further and name the parents in the same sentence:
 *
 *   This is to certify that Kumar. M KIRAN KUMAR S/O Sri. M NAGAPPA
 *   (Father Name) and Smt. M SAVITHA (Mother Name) is a resident of …
 *
 * Shapes taken from the reader's output on the user's own documents; the names
 * are changed.
 */

const valueOf = (text: string, key: string, documentKey?: string) =>
  extractFromText(text, documentKey === undefined ? {} : { documentKey: documentKey as never }).candidates.find(
    (c) => c.key === key,
  )?.value;

describe('a name certified in a sentence', () => {
  it('reads the name that ends the CBSE line', () => {
    const card = 'CENTRAL BOARD OF SECONDARY EDUCATION\nThis is to certify that R PRAVEEN KUMAR\nRoll No. : 18100001';
    expect(valueOf(card, 'identity.full_name', 'doc.marksheet_10')).toBe('R PRAVEEN KUMAR');
  });

  it('reads the person and both parents off a certificate’s sentence', () => {
    const certificate = [
      'GOVERNMENT OF KARNATAKA',
      'INCOME CERTIFICATE',
      'This is to certify that Kumar. R PRAVEEN KUMAR S/O Sri. R SRINIVASA',
      '(Father Name) and Smt. R LATHA (Mother Name) is a resident of TUMKUR',
    ].join('\n');
    expect(valueOf(certificate, 'identity.full_name', 'doc.income_certificate')).toBe('R PRAVEEN KUMAR');
    expect(valueOf(certificate, 'family.father_name', 'doc.income_certificate')).toBe('R SRINIVASA');
    expect(valueOf(certificate, 'family.mother_name', 'doc.income_certificate')).toBe('R LATHA');
  });

  it('strips the honorific, and keeps a surname that happens to be Kumar', () => {
    // "Kumar." before a name is an honorific; "KUMAR" ending one is a surname.
    const line = 'This is to certify that Kumari. R PRIYA KUMAR D/O Sri. R SRINIVASA';
    expect(valueOf(line, 'identity.full_name')).toBe('R PRIYA KUMAR');
    expect(valueOf(line, 'family.father_name')).toBe('R SRINIVASA');
  });
});

describe('a sentence that certifies no name', () => {
  it('reads nothing from "the candidate mentioned below"', () => {
    // The 2nd PUC certificate: the names come later, each under its own label.
    const card = 'This is to certify that the candidate mentioned below has completed the course';
    expect(valueOf(card, 'identity.full_name', 'doc.marksheet_12')).toBeUndefined();
  });

  it('lets a labelled name win over one read from a sentence', () => {
    const card = ['Candidate Name : R PRAVEEN KUMAR', 'This is to certify that SOMEONE ELSE'].join('\n');
    expect(valueOf(card, 'identity.full_name')).toBe('R PRAVEEN KUMAR');
  });

  it('offers what it reads as a suggestion, never as decided', () => {
    const card = 'This is to certify that R PRAVEEN KUMAR';
    const found = extractFromText(card).candidates.find((c) => c.key === 'identity.full_name');
    expect(found?.suggestChecked).toBe(false);
  });
});

describe('when two rules read the same field', () => {
  it('keeps the better-evidenced reading, whichever rule spoke first', () => {
    // A guess from position — the line above a date of birth — speaks first
    // and is weaker than a name the document certifies in a sentence.
    const card = ['This is to certify that R PRAVEEN KUMAR', 'SOMEONE ELSE', 'DOB: 01/01/2005'].join('\n');
    expect(valueOf(card, 'identity.full_name')).toBe('R PRAVEEN KUMAR');
  });
});
