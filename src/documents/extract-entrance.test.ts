import { describe, expect, it } from 'vitest';

import { isFieldKey, type FieldKey } from '@/matching/taxonomy';
import { extractFromText } from './extract';

/**
 * An entrance exam's own paperwork (§ reading a document).
 *
 * The numbers on a KEA admission ticket or a rank card are the ones a portal
 * asks for by name and nobody can recite: a CET number, a hall-ticket number, a
 * general-merit rank. They are also the ones a student copies wrong most often,
 * because they carry no meaning to check against.
 *
 * The exam matters as much as the number. A CET application number in a NEET
 * box is a rejected application, so the exam name is read from the paper too and
 * offered beside its numbers, for the user to see together.
 */

const KCET_TICKET = `
KARNATAKA EXAMINATIONS AUTHORITY
COMMON ENTRANCE TEST - 2024
ADMISSION TICKET
CET Number : GG2401234
Application Number : 24123456789
Candidate Name : PRIYA S
Father Name : SURESH KUMAR
Date of Birth : 12-03-2007
Test Centre : GOVT PU COLLEGE, TUMKUR
`;

const KCET_RANK = `
KARNATAKA EXAMINATIONS AUTHORITY
UGCET 2024 RANK CARD
CET Number : GG2401234
Candidate Name : PRIYA S
Engineering Rank : 4521
Total Marks : 164
`;

function valueOf(text: string, key: string, documentKey?: FieldKey) {
  const hint = documentKey === undefined ? {} : { documentKey };
  return extractFromText(text, hint).candidates.find((c) => c.key === key)?.value;
}

describe('a KEA admission ticket', () => {
  it('reads the CET number as the exam’s registration number', () => {
    expect(
      valueOf(KCET_TICKET, 'entrance.registration_number', 'doc.entrance_admission_ticket'),
    ).toBe('GG2401234');
  });

  it('names the exam, so the number is never filed under the wrong one', () => {
    expect(valueOf(KCET_TICKET, 'entrance.exam_name', 'doc.entrance_admission_ticket')).toBe(
      'KCET',
    );
  });

  it('reads the year of the exam', () => {
    expect(valueOf(KCET_TICKET, 'entrance.year', 'doc.entrance_admission_ticket')).toBe('2024');
  });

  it('still reads the person, because the ticket carries them too', () => {
    expect(valueOf(KCET_TICKET, 'identity.full_name', 'doc.entrance_admission_ticket')).toBe(
      'PRIYA S',
    );
    expect(valueOf(KCET_TICKET, 'identity.dob', 'doc.entrance_admission_ticket')).toBe('2007-03-12');
  });
});

describe('a rank card', () => {
  it('reads the rank', () => {
    expect(valueOf(KCET_RANK, 'entrance.rank', 'doc.entrance_rank_card')).toBe('4521');
  });

  it('reads the score', () => {
    expect(valueOf(KCET_RANK, 'entrance.score', 'doc.entrance_rank_card')).toBe('164');
  });
});

describe('an exam nobody named', () => {
  it('reads the exam off the paper itself when no slot said', () => {
    const neet = `
      NATIONAL TESTING AGENCY
      NEET (UG) 2024 ADMIT CARD
      Application Number : 240410123456
      Roll Number : 4401012345
    `;
    expect(valueOf(neet, 'entrance.exam_name')).toBe('NEET');
    expect(valueOf(neet, 'entrance.roll_number')).toBe('4401012345');
  });

  it('reads no exam numbers off a document that is not an exam’s', () => {
    const card = `
      KARNATAKA SECONDARY EDUCATION EXAMINATION BOARD
      S.S.L.C. MARKS CARD
      REGISTER NUMBER : 1234567
      STUDENT NAME : PRIYA S
    `;
    const keys = extractFromText(card, { documentKey: 'doc.marksheet_10' }).candidates.map(
      (c) => c.key,
    );
    expect(keys.filter((key) => key.startsWith('entrance.'))).toEqual([]);
  });
});

describe('what an exam paper never becomes', () => {
  it('offers nothing as already decided', () => {
    for (const text of [KCET_TICKET, KCET_RANK]) {
      expect(extractFromText(text).candidates.filter((c) => c.suggestChecked)).toEqual([]);
    }
  });

  it('returns only keys the taxonomy has', () => {
    for (const text of [KCET_TICKET, KCET_RANK]) {
      for (const candidate of extractFromText(text).candidates) {
        expect(isFieldKey(candidate.key), candidate.key).toBe(true);
      }
    }
  });
});
