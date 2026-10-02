import { describe, expect, it } from 'vitest';

import { extractFromText } from './extract';

/**
 * An address, from the one document that carries the holder's own (§ reading
 * a document).
 *
 * Aadhaar prints where the person lives. A marks card prints where their
 * school is, a caste certificate where the issuing office is — and neither is
 * an address the applicant should be filing under their own name. So this
 * reads an address from an Aadhaar card and from nothing else.
 */

const AADHAAR = `
GOVERNMENT OF INDIA
UNIQUE IDENTIFICATION AUTHORITY OF INDIA
RAVI KUMAR
DOB: 05/05/2006
MALE
9999 9999 0019
Address:
S/O MOHAN KUMAR, 12 4TH CROSS,
MALLESHWARAM, BENGALURU,
KARNATAKA - 560003
`;

function valueOf(text: string, key: string, documentKey?: string) {
  const hint = documentKey === undefined ? {} : { documentKey: documentKey as never };
  return extractFromText(text, hint).candidates.find((c) => c.key === key)?.value;
}

describe('an Aadhaar card’s address', () => {
  it('reads the address block as the person’s permanent address', () => {
    const line1 = valueOf(AADHAAR, 'address.permanent.line1');
    expect(line1).toContain('4TH CROSS');
    expect(line1).toContain('MALLESHWARAM');
    // The PIN and the state have boxes of their own; the street line is not
    // the place to repeat them.
    expect(line1).not.toContain('560003');
  });

  it('reads the PIN code and the state into their own boxes', () => {
    expect(valueOf(AADHAAR, 'address.permanent.pincode')).toBe('560003');
    expect(valueOf(AADHAAR, 'address.permanent.state')).toBe('Karnataka');
  });

  it('offers it as a suggestion, never as decided', () => {
    const result = extractFromText(AADHAAR);
    for (const candidate of result.candidates.filter((c) => c.key.startsWith('address.'))) {
      expect(candidate.suggestChecked).toBe(false);
    }
  });
});

describe('addresses on documents that are not the person’s', () => {
  it('reads no address off a marks card, where it belongs to the school', () => {
    const card = `
      KARNATAKA SECONDARY EDUCATION EXAMINATION BOARD
      S.S.L.C. MARKS CARD
      STUDENT NAME : PRIYA S
      SCHOOL : GOVT HIGH SCHOOL, 4TH CROSS, TUMKUR
      KARNATAKA - 572101
    `;
    const keys = extractFromText(card, { documentKey: 'doc.marksheet_10' }).candidates.map(
      (c) => c.key,
    );
    expect(keys.filter((key) => key.startsWith('address.'))).toEqual([]);
  });

  it('reads no address off a caste certificate, where it belongs to the office', () => {
    const certificate = `
      GOVERNMENT OF KARNATAKA
      CASTE CERTIFICATE
      RD Number : RD0123456789012
      Office of the Tahsildar, TUMKUR - 572101
      belongs to VALMIKI community
    `;
    const keys = extractFromText(certificate, {
      documentKey: 'doc.caste_certificate',
    }).candidates.map((c) => c.key);
    expect(keys.filter((key) => key.startsWith('address.'))).toEqual([]);
  });
});
