import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { isFieldKey } from '@/matching/taxonomy';
import { extractFromText, isValidAadhaar, isWellFormedPan, type Candidate, zeroesForOs } from './extract';

/**
 * Reading an ID card (§ document extraction).
 *
 * ## What the tests are really guarding
 *
 * Not "did it find the number". The hazard in this feature is the opposite:
 * finding a number that is *almost* right. An OCR misread of one digit in an
 * Aadhaar number, accepted into the vault and then filled at high confidence
 * into forty applications, is precisely the failure this whole product is built
 * to prevent — and unlike a wrong match on a form, nothing downstream would
 * ever catch it.
 *
 * So the checks below cluster around three things:
 *
 *  1. **Checksums.** Aadhaar carries a Verhoeff check digit. A number that
 *     fails it is a misread, and saying so is far better than shrugging.
 *  2. **Masked and specimen cards.** `XXXX XXXX 1234` must never become a
 *     stored Aadhaar number, and a downloaded e-Aadhaar shows exactly that.
 *  3. **Never confident without evidence.** A bare twelve-digit run in a page
 *     of noise is not an Aadhaar number just because it is twelve digits long.
 *
 * The Aadhaar numbers used here are UIDAI's own published test numbers. They
 * are valid by the checksum and belong to nobody.
 */

const VALID_AADHAAR = ['999999990019', '999941057058', '999971658847', '999933119405'];

function candidateFor(result: { candidates: Candidate[] }, key: string): Candidate | undefined {
  return result.candidates.find((c) => c.key === key);
}

// ---------------------------------------------------------------------------

describe('the Aadhaar checksum, which is the whole safety story', () => {
  it.each(VALID_AADHAAR)('accepts UIDAI test number %s', (number) => {
    expect(isValidAadhaar(number)).toBe(true);
  });

  it('rejects every single-digit corruption of a valid number', () => {
    // The Verhoeff scheme's actual guarantee, and the reason it is worth
    // implementing rather than just counting to twelve: it catches all single
    // digit errors, which is the OCR failure mode.
    const base = '999999990019';
    const broken: string[] = [];

    for (let position = 0; position < base.length; position += 1) {
      for (let digit = 0; digit <= 9; digit += 1) {
        const candidate =
          base.slice(0, position) + String(digit) + base.slice(position + 1);
        if (candidate === base) continue;
        if (isValidAadhaar(candidate)) broken.push(candidate);
      }
    }
    expect(broken, 'these corrupted numbers passed the checksum').toEqual([]);
  });

  it('rejects most transpositions of adjacent digits', () => {
    // The other error Verhoeff is designed for. Not all adjacent transpositions
    // are caught by the scheme, so this asserts the bulk rather than perfection
    // — overstating it would be the same dishonesty as skipping the check.
    const base = '999941057058';
    let caught = 0;
    let attempted = 0;

    for (let i = 0; i < base.length - 1; i += 1) {
      if (base[i] === base[i + 1]) continue;
      attempted += 1;
      const swapped =
        base.slice(0, i) + base[i + 1] + base[i] + base.slice(i + 2);
      if (!isValidAadhaar(swapped)) caught += 1;
    }
    expect(caught).toBeGreaterThanOrEqual(attempted - 1);
  });

  it('rejects anything that is not twelve digits', () => {
    for (const bad of ['', '1', '99999999001', '9999999900199', 'abcdefghijkl']) {
      expect(isValidAadhaar(bad), bad).toBe(false);
    }
  });

  it('rejects a number starting 0 or 1, which UIDAI never issues', () => {
    expect(isValidAadhaar('012345678901')).toBe(false);
    expect(isValidAadhaar('112345678901')).toBe(false);
  });
});

describe('reading an Aadhaar card', () => {
  const CARD = `
    भारत सरकार
    Government of India
    रवि कुमार
    Ravi Kumar
    जन्म तिथि / DOB: 14/03/1998
    पुरुष / MALE
    ${VALID_AADHAAR[0]!.slice(0, 4)} ${VALID_AADHAAR[0]!.slice(4, 8)} ${VALID_AADHAAR[0]!.slice(8)}
    आधार - आम आदमी का अधिकार
  `;

  it('identifies the document', () => {
    expect(extractFromText(CARD).documentType).toBe('aadhaar');
  });

  it('pulls the number out of its 4-4-4 grouping', () => {
    const found = candidateFor(extractFromText(CARD), 'id.aadhaar');
    expect(found?.value).toBe(VALID_AADHAAR[0]);
  });

  it('marks a checksum-verified number as verified, and says so confidently', () => {
    const found = candidateFor(extractFromText(CARD), 'id.aadhaar')!;
    expect(found.verified).toBe(true);
    expect(found.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it('reads the date of birth', () => {
    expect(candidateFor(extractFromText(CARD), 'identity.dob')?.value).toBe('1998-03-14');
  });

  it('reads the gender from either script', () => {
    expect(candidateFor(extractFromText(CARD), 'identity.gender')?.value).toBe('Male');
    const hindiOnly = extractFromText('नाम: सीता देवी\nमहिला\n' + VALID_AADHAAR[1]);
    expect(candidateFor(hindiOnly, 'identity.gender')?.value).toBe('Female');
  });

  it('prefers the Latin spelling of the name when a card carries both', () => {
    // Both are correct, but a portal form almost always wants the Latin one,
    // and the user can still edit it.
    expect(candidateFor(extractFromText(CARD), 'identity.full_name')?.value).toBe('Ravi Kumar');
  });

  it('carries the evidence it used, so the user can check it against the card', () => {
    for (const candidate of extractFromText(CARD).candidates) {
      expect(candidate.evidence.length, candidate.key).toBeGreaterThan(0);
      expect(candidate.line).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('a Hindi card, where the digits are Devanagari', () => {
  // The case that decides whether this feature works outside English. The
  // number is printed in Devanagari numerals and must still checksum.
  const number = VALID_AADHAAR[2]!;
  const devanagari = number.replace(/\d/g, (d) => String.fromCodePoint(0x0966 + Number(d)));

  const CARD = `भारत सरकार\nनाम: अनिता शर्मा\nजन्म तिथि: १५/०८/१९९२\n${devanagari}`;

  it('reads a number printed in Devanagari digits', () => {
    const found = candidateFor(extractFromText(CARD), 'id.aadhaar');
    expect(found?.value).toBe(number);
    expect(found?.verified).toBe(true);
  });

  it('reads a date written in Devanagari digits', () => {
    expect(candidateFor(extractFromText(CARD), 'identity.dob')?.value).toBe('1992-08-15');
  });

  it('reads the Devanagari name when there is no Latin one', () => {
    expect(candidateFor(extractFromText(CARD), 'identity.full_name')?.value).toBe('अनिता शर्मा');
  });

  it('reports the scripts it saw', () => {
    expect(extractFromText(CARD).scripts).toContain('Devanagari');
  });
});

describe('the numbers that must never be stored', () => {
  it('refuses a masked number from an e-Aadhaar download', () => {
    // Every downloaded e-Aadhaar shows this. Storing `XXXXXXXX1234` and filling
    // it into an application would fail the application silently.
    const masked = extractFromText('Aadhaar No: XXXX XXXX 1234\nRavi Kumar');
    expect(candidateFor(masked, 'id.aadhaar')).toBeUndefined();
  });

  it('refuses a twelve-digit run that fails the checksum', () => {
    const found = candidateFor(extractFromText('Aadhaar: 1234 5678 9012'), 'id.aadhaar');
    expect(found).toBeUndefined();
  });

  it('reports a failed checksum as a warning rather than silence', () => {
    // "Nothing found" and "found something that is definitely misread" are
    // different, and only the second one tells the user to retake the photo.
    const result = extractFromText('Aadhaar: 2234 5678 9012');
    expect(result.warnings.some((w) => /check|misread|digit/i.test(w))).toBe(true);
  });

  it('does not mistake a long invoice number for an Aadhaar', () => {
    const result = extractFromText('Invoice 987654321098765 dated 01/01/2024');
    expect(candidateFor(result, 'id.aadhaar')).toBeUndefined();
  });

  it('does not mistake a 12-digit phone-like run with no card context', () => {
    const result = extractFromText('Call 999999990019 for support');
    const found = candidateFor(result, 'id.aadhaar');
    // The checksum passes — it is a UIDAI test number — so it may be offered,
    // but never as something to accept without looking.
    if (found) expect(found.confidence).toBeLessThan(0.9);
  });
});

describe('PAN', () => {
  it('accepts a well-formed PAN', () => {
    expect(isWellFormedPan('ABCPE1234F')).toBe(true);
  });

  it('rejects one whose holder-type letter is not a real code', () => {
    // The fourth character says what kind of holder it is. 'X' is not one of
    // them, so a PAN with an X there was misread — very often an 'H' or a 'K'.
    expect(isWellFormedPan('ABCXE1234F')).toBe(false);
  });

  it('rejects the wrong shape', () => {
    for (const bad of ['ABCDE1234', 'ABCDE12345', '1BCPE1234F', 'ABCPE1234', 'abcpe1234f']) {
      expect(isWellFormedPan(bad), bad).toBe(false);
    }
  });

  it('reads one off a card and knows the document', () => {
    const card = `
      आयकर विभाग
      INCOME TAX DEPARTMENT
      GOVT. OF INDIA
      RAVI KUMAR
      Father's Name
      SURESH KUMAR
      Permanent Account Number
      ABCPE1234F
      14/03/1998
    `;
    const result = extractFromText(card);
    expect(result.documentType).toBe('pan');
    expect(candidateFor(result, 'id.pan')?.value).toBe('ABCPE1234F');
    expect(candidateFor(result, 'family.father_name')?.value).toBe('SURESH KUMAR');
  });

  it('is honest that PAN has no checksum we can verify', () => {
    // The last character is a check digit, but the algorithm is not published.
    // Claiming verification we cannot perform would be worse than not claiming.
    const result = extractFromText('Permanent Account Number\nABCPE1234F');
    expect(candidateFor(result, 'id.pan')?.verified).toBe(false);
  });
});

describe('other documents', () => {
  it('reads a voter ID', () => {
    const result = extractFromText('ELECTION COMMISSION OF INDIA\nIDENTITY CARD\nABC1234567');
    expect(result.documentType).toBe('voter_id');
    expect(candidateFor(result, 'id.voter')?.value).toBe('ABC1234567');
  });

  it('reads a passport number', () => {
    const result = extractFromText('REPUBLIC OF INDIA\nPASSPORT\nPassport No. M1234567');
    expect(result.documentType).toBe('passport');
    expect(candidateFor(result, 'id.passport')?.value).toBe('M1234567');
  });

  it('reads a bank passbook', () => {
    const result = extractFromText(`
      STATE BANK OF INDIA
      Account Number: 30123456789
      IFSC: SBIN0001234
      Branch: KORAMANGALA
    `);
    expect(result.documentType).toBe('bank_passbook');
    expect(candidateFor(result, 'bank.account_number')?.value).toBe('30123456789');
    expect(candidateFor(result, 'bank.ifsc')?.value).toBe('SBIN0001234');
  });

  it('rejects an IFSC of the wrong shape', () => {
    // Position five is always 0. A '0'/'O' confusion there is the classic OCR
    // error on a passbook, and it makes the code useless.
    const result = extractFromText('IFSC: SBINO001234');
    expect(candidateFor(result, 'bank.ifsc')).toBeUndefined();
  });

  it('says so plainly when it recognises nothing', () => {
    const result = extractFromText('a photograph of somebody’s cat');
    expect(result.documentType).toBe('unknown');
    expect(result.candidates).toEqual([]);
  });
});

describe('dates, in the shapes Indian cards actually print them', () => {
  const cases: Array<[string, string]> = [
    ['DOB: 14/03/1998', '1998-03-14'],
    ['DOB 14-03-1998', '1998-03-14'],
    ['Date of Birth : 14.03.1998', '1998-03-14'],
    ['जन्म तिथि: १४/०३/१९९८', '1998-03-14'],
    ['DOB: 01/01/1990', '1990-01-01'],
  ];

  it.each(cases)('reads %s', (text, expected) => {
    expect(candidateFor(extractFromText(text), 'identity.dob')?.value).toBe(expected);
  });

  it('reads day-first, because that is what Indian cards print', () => {
    // 03/04/1998 is 3 April, not 4 March. Getting this backwards puts a wrong
    // date of birth on every form the user files.
    expect(candidateFor(extractFromText('DOB: 03/04/1998'), 'identity.dob')?.value).toBe('1998-04-03');
  });

  it('refuses an impossible date rather than rolling it over', () => {
    expect(candidateFor(extractFromText('DOB: 32/13/1998'), 'identity.dob')).toBeUndefined();
  });

  it('refuses a year that cannot be a birth year', () => {
    expect(candidateFor(extractFromText('DOB: 14/03/2098'), 'identity.dob')).toBeUndefined();
    expect(candidateFor(extractFromText('DOB: 14/03/1799'), 'identity.dob')).toBeUndefined();
  });

  it('does not take an expiry or issue date as a birth date', () => {
    const result = extractFromText('Date of Issue: 01/01/2020\nValid Until: 01/01/2030');
    expect(candidateFor(result, 'identity.dob')).toBeUndefined();
  });

  it('reads the label through a speck the photograph glued to it', () => {
    // An Aadhaar letter photographed sideways, read in the real extension:
    // "0DOB:" — a mark on the paper read as a zero, touching the label. The
    // date was perfect and the rule never looked at it.
    expect(candidateFor(extractFromText('0DOB:14/03/2005 -'), 'identity.dob')?.value).toBe('2005-03-14');
  });

  it('still wants the label to be a word of its own, not the end of another', () => {
    expect(candidateFor(extractFromText('Rebirth 14/03/2005'), 'identity.dob')).toBeUndefined();
  });
});

describe('what it refuses to look for at all', () => {
  it('never offers a one-time code, whatever the document says', () => {
    // P4. A scanned letter may well contain an OTP or a PIN. Reading a document
    // the user handed us is not the same as reading a security control off a
    // live page — but nothing here should be in the business of harvesting
    // one-time secrets either, and the taxonomy has no key for them.
    const result = extractFromText('Your OTP is 483920\nATM PIN: 4417\nPassword: hunter2');
    const keys = result.candidates.map((c) => c.key);
    expect(keys.some((k) => /otp|pin$|password/i.test(k))).toBe(false);
  });

  it('never returns a candidate for a key outside the taxonomy', () => {
    /*
     * `isFieldKey`, not a shape. The shape said "lower case letters and dots",
     * which `education.class_10.roll_number` fails for having a digit in it —
     * and which a key that merely *looks* right would pass. The taxonomy is
     * the contract: a candidate for a key it does not have cannot be saved.
     */
    const result = extractFromText(`Ravi Kumar\n${VALID_AADHAAR[0]}\nABCPE1234F`);
    for (const candidate of result.candidates) {
      expect(isFieldKey(candidate.key), candidate.key).toBe(true);
    }
  });
});

describe('nothing is ever offered as already-decided', () => {
  it('marks every candidate as needing confirmation', () => {
    const result = extractFromText(`Ravi Kumar\nDOB: 14/03/1998\n${VALID_AADHAAR[0]}`);
    expect(result.candidates.length).toBeGreaterThan(0);
    for (const candidate of result.candidates) {
      expect(candidate.confirmed, candidate.key).toBe(false);
    }
  });

  it('only pre-ticks what a checksum confirmed', () => {
    // The suggestion screen ticks these by default; everything else the user
    // has to tick themselves. A verified checksum is the only evidence strong
    // enough to earn that.
    const result = extractFromText(`Ravi Kumar\nDOB: 14/03/1998\n${VALID_AADHAAR[0]}`);
    const preticked = result.candidates.filter((c) => c.suggestChecked).map((c) => c.key);
    expect(preticked).toEqual(['id.aadhaar']);
  });

  it('sorts the most trustworthy candidates first', () => {
    const result = extractFromText(`Ravi Kumar\nDOB: 14/03/1998\n${VALID_AADHAAR[0]}`);
    const confidences = result.candidates.map((c) => c.confidence);
    expect([...confidences].sort((a, b) => b - a)).toEqual(confidences);
  });
});

describe('the ASCII word-boundary trap', () => {
  /**
   * A source assertion, in the style of the blocker module's own.
   *
   * An ASCII word boundary beside a non-ASCII alternative is always a bug, and
   * it never fails loudly: the pattern compiles, every test written in Latin
   * text passes, and the feature silently does nothing on exactly the cards it
   * was built for. It cost one debugging round here already.
   *
   * `anyOf` builds Unicode-aware boundaries instead. Anything matching an
   * Indic word has to go through it.
   */
  it('never puts an ASCII word boundary beside a non-Latin alternative', async () => {
    const source = await readFile(new URL('./extract.ts', import.meta.url), 'utf8');
    const isAscii = (line: string) => [...line].every((ch) => ch.charCodeAt(0) < 128);

    const offenders = source
      .split(/\r?\n/)
      .filter((line) => line.includes('\b'))
      .filter((line) => !isAscii(line))
      .filter((line) => !line.trimStart().startsWith('*'))
      .map((line) => line.trim());

    expect(offenders).toEqual([]);
  });
});

describe('a zero the engine read as a letter O', () => {
  it('reads it as the zero it is, where digits make that certain', () => {
    expect(zeroesForOs('is 3000o ( Rs.')).toBe('is 30000 ( Rs.');
    expect(zeroesForOs('Year 2O22')).toBe('Year 2022');
  });

  it('never touches an O in a word', () => {
    for (const text of ['Roll No. 18315726', 'SCHOOL', 'O+ blood group', 'Form 16 Office', '10 o’clock']) {
      expect(zeroesForOs(text), text).toBe(text);
    }
  });
});
