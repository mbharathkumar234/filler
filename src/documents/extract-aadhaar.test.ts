import { describe, expect, it } from 'vitest';

import { isFieldKey } from '@/matching/taxonomy';
import { extractFromText } from './extract';

/**
 * The e-Aadhaar letter, which is the document with the most on it (§ reading a
 * document).
 *
 * Not the little card: the full A4 letter UIDAI issues as a PDF, and the one
 * every portal asks to be uploaded. It carries a whole addressed block —
 * S/O, VTC, PO, Sub District, District, State, PIN, mobile — printed as
 * labelled lines, and almost none of it was being read. A user who pressed
 * "Read details from this" on it got a page of recognised text and **one**
 * suggestion, plus a warning about a number that had not in fact been misread.
 *
 * The numbers below are invented. The layout is exactly UIDAI's.
 */
const LETTER = `
Government of India
Unique Identification Authority of India
Enrolment No.: 1234/56789/01234
To
ಆರ್ ಪ್ರವೀಣ್ ಕುಮಾರ್
R Praveen Kumar
S/O: R Srinivasa,
VTC: Hosahalli,
PO: Kodihalli,
Sub District: Chiknayakanahalli,
District: Tumkur,
State: Karnataka,
PIN Code: 560001,
Mobile: 9876543210
ನಿಮ್ಮ ಆಧಾರ್ ಸಂಖ್ಯೆ / Your Aadhaar No. :
XXXX XXXX 5521
VID : 4417 0290 6831 5502
R Praveen Kumar
DOB: 14/03/2005
ಪುರುಷ/ MALE
Address:
S/O: R Srinivasa, Hosahalli, PO: Kodihalli, DIST: Tumkur,
Karnataka - 560001
`;

const read = () => extractFromText(LETTER, { documentKey: 'doc.aadhaar_card' });
const valueOf = (key: string) => read().candidates.find((c) => c.key === key)?.value;

describe('the addressed block on an Aadhaar letter', () => {
  it('reads the village, the taluk and the district into their own boxes', () => {
    // "Sub District" is the taluk. Filed under `city` or `district` it would be
    // a wrong answer in a box a portal checks against the certificate.
    expect(valueOf('address.permanent.city')).toBe('Hosahalli');
    expect(valueOf('address.permanent.taluk')).toBe('Chiknayakanahalli');
    expect(valueOf('address.permanent.district')).toBe('Tumkur');
  });

  it('reads the state and the PIN code', () => {
    expect(valueOf('address.permanent.state')).toBe('Karnataka');
    expect(valueOf('address.permanent.pincode')).toBe('560001');
  });

  it('reads the post office as the second address line', () => {
    expect(valueOf('address.permanent.line2')).toBe('Kodihalli');
  });

  it('reads the mobile number printed on the letter', () => {
    expect(valueOf('contact.mobile')).toBe('9876543210');
  });

  it('reads S/O as the father’s name', () => {
    expect(valueOf('family.father_name')).toBe('R Srinivasa');
  });

  it('reads the person, their date of birth and their gender', () => {
    expect(valueOf('identity.full_name')).toBe('R Praveen Kumar');
    expect(valueOf('identity.dob')).toBe('2005-03-14');
    expect(valueOf('identity.gender')).toBe('Male');
  });

  it('offers enough of the letter to be worth the press', () => {
    // The complaint that started this: one suggestion from a page covered in
    // labelled values.
    expect(read().candidates.length).toBeGreaterThanOrEqual(9);
  });

  it('returns only keys the taxonomy has, and decides nothing by itself', () => {
    for (const candidate of read().candidates) {
      expect(isFieldKey(candidate.key), candidate.key).toBe(true);
      if (!candidate.verified) expect(candidate.suggestChecked).toBe(false);
    }
  });
});

describe('the two numbers on the letter that are not the Aadhaar number', () => {
  it('never reads a VID as an Aadhaar number', () => {
    /*
     * The false warning the user saw. A VID is sixteen digits in four groups;
     * the first twelve of them are a 4-4-4 run followed by a space, so the rule
     * that refuses "part of a longer run" never noticed, failed the checksum on
     * a number that was read perfectly, and blamed the photograph.
     */
    expect(read().warnings.join(' ')).not.toMatch(/check digit/i);
    expect(valueOf('id.aadhaar')).toBeUndefined();
  });

  it('says the number on the letter is masked, rather than blaming the picture', () => {
    expect(read().warnings.join(' ')).toMatch(/masked/i);
  });

  it('keeps the enrolment number out of every box, and says it did', () => {
    const keys = read().candidates.map((c) => c.key);
    expect(keys.filter((key) => key.startsWith('id.'))).toEqual([]);
    expect(read().notes.join(' ')).toMatch(/enrolment/i);
  });
});

describe('what these labels do to a document that is not an Aadhaar letter', () => {
  it('reads no address block off a marks card that names a district', () => {
    const card = `
      KARNATAKA SECONDARY EDUCATION EXAMINATION BOARD
      S.S.L.C. MARKS CARD
      STUDENT NAME : PRIYA S
      District : Tumkur
      School : GOVT HIGH SCHOOL TUMKUR
    `;
    const keys = extractFromText(card, { documentKey: 'doc.marksheet_10' }).candidates.map(
      (c) => c.key,
    );
    expect(keys.filter((key) => key.startsWith('address.'))).toEqual([]);
  });
});

describe('the same letter, as recognition actually returned it', () => {
  /*
   * Not an imagined degradation: these are the exact label shapes the engine
   * produced from the user's own e-Aadhaar, with the names changed. "S/O:"
   * came back as "5/ಲಿ:" — the S read as a 5, the O as a Kannada letter — and
   * "District," as "Destict,", with a comma where the colon should be.
   *
   * A label the engine half-read is still a label. The guard against reading
   * nonsense into the vault is the *value*: a place name, a person's name, six
   * digits. That is what makes forgiving the label safe.
   */
  const AS_READ = `
we ww ATHY | covermmemot nce AADHAAR
decoded soay Enrolment No.: 1234/56789/01234 : 5) DV.ba0t OR occ
ಆರ್ ಪ್ರವೀಣ್ ಕುಮಾರ್
5/ಲಿ: R Srinivasa,
VTC: Hosahalli,
PO: Kodihalli,
Sub District: Chiknayakanahall,
Destict, Tumkur,
PIN Code: 560001,
Mobile: 9876543210
XXXX XXXX 5521
: 4417 0290 6831 5502 )
R Praveen Kumar
ಇ ಟಿ MALE
`;

  const seen = () => extractFromText(AS_READ, { documentKey: 'doc.aadhaar_card' });
  const got = (key: string) => seen().candidates.find((c) => c.key === key)?.value;

  it('still reads the father’s name through a mangled S/O', () => {
    expect(got('family.father_name')).toBe('R Srinivasa');
  });

  it('still reads the district through a misspelt label and a comma', () => {
    expect(got('address.permanent.district')).toBe('Tumkur');
  });

  it('reads the village, taluk, post office, PIN and mobile as before', () => {
    expect(got('address.permanent.city')).toBe('Hosahalli');
    expect(got('address.permanent.taluk')).toBe('Chiknayakanahall');
    expect(got('address.permanent.line2')).toBe('Kodihalli');
    expect(got('address.permanent.pincode')).toBe('560001');
    expect(got('contact.mobile')).toBe('9876543210');
  });

  it('is not fooled into an Aadhaar number by the VID on the line below', () => {
    expect(got('id.aadhaar')).toBeUndefined();
    expect(seen().warnings.join(' ')).not.toMatch(/check digit/i);
  });

  it('offers a useful number of rows from a page that gave one', () => {
    expect(seen().candidates.length).toBeGreaterThanOrEqual(7);
  });
});

describe('the name on the address label', () => {
  it('reads the name under "To", where the letter addresses its holder', () => {
    // As the reader returns it: the Kannada line under "To" was dropped as a
    // script the English model cannot read, and the Latin line follows.
    const letter = [
      'Unique Identification Authority of India',
      'To',
      'R Praveen Kumar',
      'S/O: R Srinivasa,',
      'VTC: Hosahalli,',
    ].join('\n');
    expect(
      extractFromText(letter, { documentKey: 'doc.aadhaar_card' }).candidates.find(
        (c) => c.key === 'identity.full_name',
      )?.value,
    ).toBe('R Praveen Kumar');
  });
});
