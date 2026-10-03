import { describe, expect, it } from 'vitest';

import { isFieldKey, type FieldKey } from '@/matching/taxonomy';
import { extractFromText } from './extract';

/**
 * Reading the certificates a claim rests on (§ reading a document).
 *
 * Karnataka's Nadakacheri certificates all carry an **RD number**, which is
 * what a portal asks for in a text box beside the upload, and which nobody can
 * remember. Each kind carries one, and they are not interchangeable: the
 * caste certificate's number in the income certificate's box is a rejected
 * application.
 *
 * Which number is which comes from the slot the document was filed under,
 * falling back to what the certificate calls itself.
 */

const CASTE = `
GOVERNMENT OF KARNATAKA
REVENUE DEPARTMENT
CASTE CERTIFICATE
RD Number : RD0123456789012
This is to certify that Kum PRIYA S
D/o SURESH KUMAR
Resident of TUMKUR TALUK, TUMKUR DISTRICT
belongs to VALMIKI community
which is recognised as a Scheduled Tribe under the Constitution
Date : 12/04/2023
`;

const INCOME = `
GOVERNMENT OF KARNATAKA
REVENUE DEPARTMENT
INCOME CERTIFICATE
RD Number : RD9876543210987
This is to certify that the annual income of the family of Kum PRIYA S
is Rs. 1,20,000 (Rupees One Lakh Twenty Thousand Only)
for the year 2023-24
`;

const ARTICLE_371J = `
GOVERNMENT OF KARNATAKA
ELIGIBILITY CERTIFICATE UNDER ARTICLE 371(J)
ANNEXURE-A
RD Number : RD5555566666777
The candidate belongs to the Kalyana Karnataka region
`;

const DOMICILE = `
GOVERNMENT OF KARNATAKA
DOMICILE AND NATIVITY CERTIFICATE
RD Number : RD1111122222333
This is to certify that Kum PRIYA S is a permanent resident of KARNATAKA state
`;

function valueOf(text: string, key: string, documentKey?: FieldKey) {
  const hint = documentKey === undefined ? {} : { documentKey };
  return extractFromText(text, hint).candidates.find((c) => c.key === key)?.value;
}

describe('a caste certificate', () => {
  it('reads the RD number into the caste certificate’s own box', () => {
    expect(valueOf(CASTE, 'eligibility.caste_certificate_number', 'doc.caste_certificate')).toBe(
      'RD0123456789012',
    );
  });

  it('reads the community and the category it is recognised under', () => {
    expect(valueOf(CASTE, 'eligibility.caste', 'doc.caste_certificate')).toBe('VALMIKI');
    expect(valueOf(CASTE, 'identity.category', 'doc.caste_certificate')).toBe('ST');
  });

  it('never puts a caste number in the income certificate’s box', () => {
    const keys = extractFromText(CASTE, { documentKey: 'doc.caste_certificate' }).candidates.map(
      (c) => c.key,
    );
    expect(keys).not.toContain('eligibility.income_certificate_number');
  });
});

describe('an income certificate', () => {
  it('reads its own RD number', () => {
    expect(valueOf(INCOME, 'eligibility.income_certificate_number', 'doc.income_certificate')).toBe(
      'RD9876543210987',
    );
  });

  it('reads the income as a number a form can take', () => {
    // "Rs. 1,20,000" — lakh grouping, and a form wants digits.
    expect(valueOf(INCOME, 'family.annual_income', 'doc.income_certificate')).toBe('120000');
  });
});

describe('an Article 371(J) certificate', () => {
  it('reads its RD number and records that the claim is made', () => {
    expect(
      valueOf(ARTICLE_371J, 'eligibility.article_371j_number', 'doc.article_371j_certificate'),
    ).toBe('RD5555566666777');
    expect(valueOf(ARTICLE_371J, 'eligibility.article_371j', 'doc.article_371j_certificate')).toBe(
      'Yes',
    );
  });
});

describe('a domicile certificate', () => {
  it('reads the state it certifies', () => {
    expect(valueOf(DOMICILE, 'eligibility.domicile_state', 'doc.domicile_certificate')).toBe(
      'KARNATAKA',
    );
  });
});

describe('when nobody said which certificate it is', () => {
  it('reads the kind off the certificate itself', () => {
    // No slot given: the certificate names itself in its own heading.
    expect(valueOf(CASTE, 'eligibility.caste_certificate_number')).toBe('RD0123456789012');
    expect(valueOf(INCOME, 'eligibility.income_certificate_number')).toBe('RD9876543210987');
  });

  it('keeps an unattributable number to itself rather than guessing a box', () => {
    const vague = 'GOVERNMENT OF KARNATAKA\nCERTIFICATE\nRD Number : RD0000011111222\n';
    const keys = extractFromText(vague).candidates.map((c) => c.key);
    expect(keys.filter((key) => key.endsWith('_certificate_number'))).toEqual([]);
  });
});

describe('what a certificate never becomes', () => {
  it('offers nothing as already decided', () => {
    for (const text of [CASTE, INCOME, ARTICLE_371J, DOMICILE]) {
      expect(extractFromText(text).candidates.filter((c) => c.suggestChecked)).toEqual([]);
    }
  });

  it('returns only keys the taxonomy has', () => {
    for (const text of [CASTE, INCOME, ARTICLE_371J, DOMICILE]) {
      for (const candidate of extractFromText(text).candidates) {
        expect(isFieldKey(candidate.key), candidate.key).toBe(true);
      }
    }
  });
});

describe('certificates as the reader actually returns them', () => {
  it('reads a certificate number printed twice on one line', () => {
    // Nadakacheri prints it once plainly and once in asterisks for the barcode.
    const certificate =
      'INCOME CERTIFICATE\nCertificate No: RD9876543210987 *RD9876543210987*\n';
    expect(valueOf(certificate, 'eligibility.income_certificate_number', 'doc.income_certificate')).toBe(
      'RD9876543210987',
    );
  });

  it('reads the income out of the certificate’s own sentence', () => {
    const certificate =
      'INCOME CERTIFICATE\nTaluk of Tumkur District. Their family annual income from all sources is 45000 ( Rs. forty five thousand\nonly.).';
    expect(valueOf(certificate, 'family.annual_income', 'doc.income_certificate')).toBe('45000');
  });

  it('reads a zero the engine took for a letter O', () => {
    // "4500o": the last digit misread as a lowercase o, beside four digits.
    const certificate =
      'INCOME CERTIFICATE\nTheir family annual income from all sources is 4500o ( Rs. forty five thousand only.).';
    expect(valueOf(certificate, 'family.annual_income', 'doc.income_certificate')).toBe('45000');
  });
});

describe('an income the recogniser read only in words', () => {
  /*
   * The line as the reader returned it from the user's own certificate: the
   * bold figure gone, the words clipped but there.
   */
  const AS_READ =
    'INCOME CERTIFICATE\nTaluk of Tumkur Distrit. Their fmily annual incme rom all sources is  Rs. forty five thousn\nonly.).';

  it('reads the amount from the words when the figure did not come through', () => {
    expect(valueOf(AS_READ, 'family.annual_income', 'doc.income_certificate')).toBe('45000');
  });

  it('is less sure of it than of a figure, and never ticks it', () => {
    const found = extractFromText(AS_READ, { documentKey: 'doc.income_certificate' }).candidates.find(
      (c) => c.key === 'family.annual_income',
    );
    expect(found!.confidence).toBeLessThan(0.75);
    expect(found!.suggestChecked).toBe(false);
  });

  it('says so when the figure and the words disagree', () => {
    // One of the two was misread; the user is told which two to compare.
    const disagree =
      'INCOME CERTIFICATE\nTheir family annual income from all sources is 80000 ( Rs. forty five thousand only.).';
    const result = extractFromText(disagree, { documentKey: 'doc.income_certificate' });
    expect(result.warnings.join(' ')).toMatch(/80000/);
    expect(result.warnings.join(' ')).toMatch(/45000/);
  });

  it('says nothing when they agree', () => {
    const agree =
      'INCOME CERTIFICATE\nTheir family annual income from all sources is 45000 ( Rs. forty five thousand only.).';
    expect(extractFromText(agree, { documentKey: 'doc.income_certificate' }).warnings).toEqual([]);
  });
});

describe('when, and by whom, a certificate was issued', () => {
  /*
   * What the reader gave for a made-up caste certificate
   * (`fixtures/images/caste-certificate-seal.png`) whose issuing authority is
   * printed nowhere but in its round seal: the page's lines, then the seal read
   * straightened (`seal.ts`), as a line of its own. Its serif face prints 0 as a
   * small o, and the reader says so.
   */
  const SEALED = [
    'GOVERNMENT OF KARNATAKA — SAMPLE',
    'Revenue Department',
    'CASTE CERTIFICATE (SAMPLE)',
    'RD Number : RDo987654321012',
    'This is to certify that Sri ARJUN MEHTA, son of RAMESH MEHTA, resident of Samplepura village, Samplepura',
    'Taluk, belongs to the Samplecaste caste, which is recognised as Category-2A.',
    'Date of Issue : 14/o3/2024',
    'Place : Samplepura',
    'GOVT. OF',
    'KARNATAKA',
    'Sit E',
    'Samplegowda',
    'SAMPLE — made up for software tests. Not a real document.',
    'Seal: TAHSILDAR, SAMPLEPURA TALUK',
  ].join('\n');

  const read = (text: string, documentKey: FieldKey = 'doc.caste_certificate') =>
    extractFromText(text, { documentKey }).candidates;
  const value = (text: string, key: string, documentKey?: FieldKey) =>
    read(text, documentKey).find((c) => c.key === key)?.value;

  it('reads the issuing authority off the seal, the only place it is printed — its picture the seal', () => {
    const authority = read(SEALED).find((c) => c.key === 'eligibility.caste_certificate_authority');
    expect(authority?.value).toBe('TAHSILDAR, SAMPLEPURA TALUK');
    expect(authority?.line).toBe(13);
    expect(authority?.suggestChecked).toBe(false);
  });

  it('reads the date of issue, and the RD number, whatever the font did to their zeros', () => {
    expect(value(SEALED, 'eligibility.caste_certificate_date')).toBe('2024-03-14');
    expect(value(SEALED, 'eligibility.caste_certificate_number')).toBe('RD0987654321012');
  });

  it('prefers the authority as printed to the seal, and as labelled to both', () => {
    const printed = `${CASTE}Tahsildar, Tumkur Taluk\nSeal: TAHSILDAR, TUMKUR TALUK\n`;
    expect(value(printed, 'eligibility.caste_certificate_authority')).toBe('Tahsildar, Tumkur Taluk');
    const labelled = `${printed}Issuing Authority : Sub-Divisional Magistrate, Tumkur\n`;
    expect(value(labelled, 'eligibility.caste_certificate_authority')).toBe('Sub-Divisional Magistrate, Tumkur');
  });

  it('takes no seal, and no line, that names no officer', () => {
    const school = `${CASTE}Seal: SAMPLE HIGH SCHOOL, SAMPLEPURA\nIssued by : the office\n`;
    expect(value(school, 'eligibility.caste_certificate_authority')).toBeUndefined();
  });

  it('reads a plain "Date" as the date of issue, and never a date of birth', () => {
    expect(value(CASTE, 'eligibility.caste_certificate_date')).toBe('2023-04-12');
    const born = 'CASTE CERTIFICATE\nRD Number : RD0123456789012\nDate of Birth : 01/01/2005\n';
    expect(value(born, 'eligibility.caste_certificate_date')).toBeUndefined();
  });

  it('files the date and the authority under the certificate they came from', () => {
    const income = `${INCOME}Date of Issue : 02/05/2023\nSeal: DEPUTY TAHSILDAR, SAMPLEPURA\n`;
    expect(value(income, 'eligibility.income_certificate_date', 'doc.income_certificate')).toBe('2023-05-02');
    expect(value(income, 'eligibility.income_certificate_authority', 'doc.income_certificate')).toBe(
      'DEPUTY TAHSILDAR, SAMPLEPURA',
    );
    expect(read(income, 'doc.income_certificate').some((c) => c.key.startsWith('eligibility.caste_certificate'))).toBe(
      false,
    );
    const article = `${ARTICLE_371J}Date : 03/06/2022\nSeal: ASSISTANT COMMISSIONER, SAMPLEPURA SUB-DIVISION\n`;
    expect(value(article, 'eligibility.article_371j_date', 'doc.article_371j_certificate')).toBe('2022-06-03');
    expect(value(article, 'eligibility.article_371j_authority', 'doc.article_371j_certificate')).toBe(
      'ASSISTANT COMMISSIONER, SAMPLEPURA SUB-DIVISION',
    );
  });

  it('gives a domicile certificate’s number a box of its own at last', () => {
    expect(value(DOMICILE, 'eligibility.domicile_certificate_number', 'doc.domicile_certificate')).toBe(
      'RD1111122222333',
    );
  });

  it('files nothing when nobody said which certificate it is', () => {
    const vague = 'GOVERNMENT OF KARNATAKA\nCERTIFICATE\nDate : 12/04/2023\nSeal: TAHSILDAR, TUMKUR TALUK\n';
    const keys = extractFromText(vague).candidates.map((c) => c.key);
    expect(keys.filter((key) => /_date$|_authority$/.test(key))).toEqual([]);
  });
});
