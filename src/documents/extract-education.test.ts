import { describe, expect, it } from 'vitest';

import { isFieldKey, type FieldKey } from '@/matching/taxonomy';
import { extractFromText } from './extract';

/**
 * A marks card, read (§ reading a document).
 *
 * Two real shapes: CBSE's statement, which prints marks in figures and words
 * and calls the student's number a Roll No.; and Karnataka's SSLC card, which
 * prints a Register Number, a maximum per subject, and a total. The text below
 * is what OCR gives back for each — upper case, labels and values on one line,
 * a table flattened into rows.
 *
 * What the user asked for, in their words: "an class 10 marks sheet gives you
 * student name, student's father and mother name, school board, name AND
 * address, class 10 subjects, their marks, total marks, result status, dob of
 * student, exam registration number of student".
 *
 * Two of those have nowhere to go and are not invented: the **school's
 * address** (the taxonomy has no key for an institution's address, and the
 * applicant's own address must never take it) and **per-subject marks** (there
 * is one `subjects` key, so the subjects are listed and the totals go to
 * `marks_obtained` / `max_marks`).
 */

const CBSE = `
CENTRAL BOARD OF SECONDARY EDUCATION
SECONDARY SCHOOL EXAMINATION (CLASS X) 2022
MARKS STATEMENT CUM PASS CERTIFICATE
Roll No. 12345678
Candidate Name : RAVI KUMAR
Mother's Name : LAKSHMI DEVI
Father's Name : MOHAN KUMAR
School : KENDRIYA VIDYALAYA MALLESHWARAM BENGALURU
Date of Birth : 05/05/2006
SUBJECT MARKS OBTAINED
ENGLISH LANG AND LIT 085 EIGHTY FIVE
HINDI COURSE B 078 SEVENTY EIGHT
MATHEMATICS 092 NINETY TWO
SCIENCE 088 EIGHTY EIGHT
SOCIAL SCIENCE 081 EIGHTY ONE
RESULT : PASS
`;

const SSLC = `
KARNATAKA SECONDARY EDUCATION EXAMINATION BOARD
S.S.L.C. MARKS CARD
REGISTER NUMBER : 1234567
STUDENT NAME : PRIYA S
FATHER NAME : SURESH KUMAR
MOTHER NAME : GEETHA
SCHOOL : GOVT HIGH SCHOOL TUMKUR
DATE OF BIRTH : 12-03-2007
SUBJECT MAX MARKS OBTAINED
KANNADA 125 110
ENGLISH 100 88
MATHEMATICS 100 95
SCIENCE 100 92
SOCIAL SCIENCE 100 89
TOTAL 625 565
PERCENTAGE 90.40
RESULT : PASS
YEAR OF PASSING : APRIL 2023
`;

function valueOf(text: string, key: string, documentKey: FieldKey = 'doc.marksheet_10') {
  return extractFromText(text, { documentKey }).candidates.find((c) => c.key === key)?.value;
}

describe('a Karnataka SSLC marks card', () => {
  it('reads the student, their parents and their date of birth', () => {
    expect(valueOf(SSLC, 'identity.full_name')).toBe('PRIYA S');
    expect(valueOf(SSLC, 'family.father_name')).toBe('SURESH KUMAR');
    expect(valueOf(SSLC, 'family.mother_name')).toBe('GEETHA');
    expect(valueOf(SSLC, 'identity.dob')).toBe('2007-03-12');
  });

  it('reads the board and the school, under Class 10 because that is the card', () => {
    expect(valueOf(SSLC, 'education.class_10.board_or_university')).toBe(
      'KARNATAKA SECONDARY EDUCATION EXAMINATION BOARD',
    );
    expect(valueOf(SSLC, 'education.class_10.institution')).toBe('GOVT HIGH SCHOOL TUMKUR');
  });

  it('reads the register number as a registration number', () => {
    expect(valueOf(SSLC, 'education.class_10.registration_number')).toBe('1234567');
  });

  it('reads the totals, the percentage and the result', () => {
    expect(valueOf(SSLC, 'education.class_10.marks_obtained')).toBe('565');
    expect(valueOf(SSLC, 'education.class_10.max_marks')).toBe('625');
    expect(valueOf(SSLC, 'education.class_10.percentage')).toBe('90.40');
    expect(valueOf(SSLC, 'education.class_10.result_status')).toBe('PASS');
  });

  it('lists the subjects it sat, in the order the card prints them', () => {
    expect(valueOf(SSLC, 'education.class_10.subjects')).toBe(
      'KANNADA, ENGLISH, MATHEMATICS, SCIENCE, SOCIAL SCIENCE',
    );
  });

  it('reads the year it was passed', () => {
    expect(valueOf(SSLC, 'education.class_10.year_of_passing')).toBe('2023');
  });
});

describe('a CBSE Class 10 statement', () => {
  it('reads the roll number, which CBSE prints instead of a register number', () => {
    expect(valueOf(CBSE, 'education.class_10.roll_number')).toBe('12345678');
  });

  it('reads the board, the school and the student', () => {
    expect(valueOf(CBSE, 'education.class_10.board_or_university')).toBe(
      'CENTRAL BOARD OF SECONDARY EDUCATION',
    );
    expect(valueOf(CBSE, 'education.class_10.institution')).toBe(
      'KENDRIYA VIDYALAYA MALLESHWARAM BENGALURU',
    );
    expect(valueOf(CBSE, 'identity.full_name')).toBe('RAVI KUMAR');
  });

  it('adds up what the card does not: marks in figures, with no printed total', () => {
    // 85 + 78 + 92 + 88 + 81. A total the card prints is preferred; this one
    // has none, and five subjects at five numbers is not a guess.
    expect(valueOf(CBSE, 'education.class_10.marks_obtained')).toBe('424');
    expect(valueOf(CBSE, 'education.class_10.subjects')).toContain('MATHEMATICS');
  });

  it('reads the year from the examination line', () => {
    expect(valueOf(CBSE, 'education.class_10.year_of_passing')).toBe('2022');
  });

  it('reads the result', () => {
    expect(valueOf(CBSE, 'education.class_10.result_status')).toBe('PASS');
  });
});

describe('which qualification the card belongs to', () => {
  it('files a PUC card under Class 12, on the same rules', () => {
    const puc = SSLC.replace('S.S.L.C. MARKS CARD', 'SECOND PUC MARKS CARD');
    const result = extractFromText(puc, { documentKey: 'doc.marksheet_12' });
    const keys = result.candidates.map((c) => c.key);

    expect(keys).toContain('education.class_12.marks_obtained');
    expect(keys).not.toContain('education.class_10.marks_obtained');
  });

  it('files a semester card under the degree', () => {
    const result = extractFromText(SSLC, { documentKey: 'doc.semester_marksheet' });
    expect(result.candidates.map((c) => c.key)).toContain(
      'education.undergraduate.marks_obtained',
    );
  });

  it('reads nothing educational from a card it was given no name for', () => {
    // Without a document key there is no way to know *whose* marks these are,
    // and filing Class 10 marks under Class 12 is worse than filing nothing.
    const keys = extractFromText(SSLC).candidates.map((c) => c.key);
    expect(keys.filter((key) => key.startsWith('education.'))).toEqual([]);
    // The person is still the person, whatever the card is.
    expect(keys).toContain('identity.full_name');
  });
});

describe('what it will not do', () => {
  it('never takes the school’s address as the applicant’s', () => {
    const withAddress = `${SSLC}\nSCHOOL ADDRESS : 4TH CROSS, TUMKUR 572101\n`;
    const keys = extractFromText(withAddress, { documentKey: 'doc.marksheet_10' }).candidates.map(
      (c) => c.key,
    );
    expect(keys.filter((key) => key.startsWith('address.'))).toEqual([]);
  });

  it('offers nothing as already decided: a marks card carries no checksum', () => {
    const result = extractFromText(SSLC, { documentKey: 'doc.marksheet_10' });
    expect(result.candidates.filter((c) => c.suggestChecked)).toEqual([]);
  });

  it('returns only keys the taxonomy has', () => {
    for (const candidate of extractFromText(SSLC, { documentKey: 'doc.marksheet_10' }).candidates) {
      expect(isFieldKey(candidate.key), candidate.key).toBe(true);
    }
  });
});

describe('the certificates issued alongside a marks card', () => {
  /*
   * A transfer certificate is not a marks card, but it prints the same two
   * things a portal asks for about a school: what the school was called and the
   * number the student sat under. The slot names the level, so there is nothing
   * to guess.
   */
  const TRANSFER = `
    GOVERNMENT HIGH SCHOOL, TUMKUR
    TRANSFER CERTIFICATE
    Name of the School : GOVT HIGH SCHOOL TUMKUR
    Board : KARNATAKA SECONDARY EDUCATION EXAMINATION BOARD
    Register Number : 1234567
    Name of the Student : PRIYA S
    Year of Passing : 2022
  `;

  it('files a Class 10 transfer certificate under Class 10', () => {
    const values = new Map(
      extractFromText(TRANSFER, { documentKey: 'doc.transfer_certificate_10' }).candidates.map(
        (c) => [c.key, c.value],
      ),
    );
    expect(values.get('education.class_10.institution')).toBe('GOVT HIGH SCHOOL TUMKUR');
    expect(values.get('education.class_10.registration_number')).toBe('1234567');
    expect(values.get('education.class_10.year_of_passing')).toBe('2022');
  });

  it('files a Class 12 study certificate under Class 12', () => {
    const study = TRANSFER.replace('TRANSFER CERTIFICATE', 'STUDY CERTIFICATE');
    const keys = extractFromText(study, { documentKey: 'doc.study_certificate_12' }).candidates.map(
      (c) => c.key,
    );
    expect(keys).toContain('education.class_12.institution');
    expect(keys.filter((key) => key.startsWith('education.class_10.'))).toEqual([]);
  });

  it('guesses no level for a certificate whose slot names none', () => {
    const keys = extractFromText(TRANSFER, { documentKey: 'doc.study_certificate' }).candidates.map(
      (c) => c.key,
    );
    expect(keys.filter((key) => key.startsWith('education.'))).toEqual([]);
  });
});

describe('saying out loud what it could not save', () => {
  /*
   * The two limits above are invisible on the screen unless the reader says
   * them. A user who asked for "class 10 subjects, their marks" and is handed
   * one joined line of subject names would otherwise be left wondering whether
   * the marks were dropped or misread. So the reader reports what it saw and
   * had nowhere to put, in the same breath as what it saved.
   */
  it('says a degree’s subject marks have no box, having read the subjects', () => {
    // A school card's subjects have a box each; a degree has forty subjects
    // and a transcript, and the vault keeps the list and the totals.
    const semester = `
      VISVESVARAYA TECHNOLOGICAL UNIVERSITY
      DATA STRUCTURES 100 78
      OPERATING SYSTEMS 100 81
      COMPUTER NETWORKS 100 74
    `;
    const result = extractFromText(semester, { documentKey: 'doc.semester_marksheet' });
    expect(result.candidates.map((c) => c.key)).toContain('education.undergraduate.subjects');
    expect(result.notes.join(' ')).toMatch(/each subject/i);
  });

  it('says nothing about subjects it found a box for', () => {
    const result = extractFromText(SSLC, { documentKey: 'doc.marksheet_10' });
    expect(result.candidates.map((c) => c.key)).toContain('education.class_10.marks_mathematics');
    expect(result.notes.join(' ')).not.toMatch(/each subject|no box/i);
  });

  it('says the school’s address was left where it belongs', () => {
    const withAddress = `${SSLC}\nSCHOOL ADDRESS : 4TH CROSS, TUMKUR 572101\n`;
    const result = extractFromText(withAddress, { documentKey: 'doc.marksheet_10' });
    expect(result.notes.join(' ')).toMatch(/school/i);
    expect(result.notes.join(' ')).toMatch(/not saved as your (?:own )?address/i);
  });

  it('stays quiet about limits it did not run into', () => {
    // A certificate with no subject table and no school on it: nothing to say.
    const certificate = 'GOVERNMENT OF KARNATAKA\nCASTE CERTIFICATE\nRD Number : RD0123456789012\n';
    const result = extractFromText(certificate, { documentKey: 'doc.caste_certificate' });
    expect(result.notes).toEqual([]);
  });
});

describe('a card printed in Kannada and English, which is most of them', () => {
  /*
   * What a 2nd PUC marks card actually looks like once the Kannada model is
   * loaded: each label twice, the values once. Read with English alone, the
   * Kannada half came back as broken Latin spliced into the same lines — which
   * is how "Board or university" ended up holding
   * "a. E Shb zn DEPARTMENT OF PRE-UNIVERSITY EDUCATION fe” |".
   */
  const PUC = `
ಕರ್ನಾಟಕ ಸರ್ಕಾರ
DEPARTMENT OF PRE-UNIVERSITY EDUCATION
ದ್ವಿತೀಯ ಪಿ.ಯು.ಸಿ. ಅಂಕಪಟ್ಟಿ / SECOND PUC MARKS CARD
ನೋಂದಣಿ ಸಂಖ್ಯೆ / Register Number : 2024123456
ವಿದ್ಯಾರ್ಥಿಯ ಹೆಸರು / Student Name : KIRAN KUMAR
ತಂದೆಯ ಹೆಸರು : MANJUNATHA
ತಾಯಿಯ ಹೆಸರು : SHOBHA
ಜನ್ಮ ದಿನಾಂಕ : 05-05-2006
ಕಾಲೇಜು / College : SRI VIDYA PU COLLEGE
SUBJECT MAX MARKS
KANNADA 100 92
ENGLISH 100 88
PHYSICS 100 95
CHEMISTRY 100 91
MATHEMATICS 100 98
BIOLOGY 100 94
ಒಟ್ಟು ಅಂಕಗಳು / Total Marks : 600 558
ಫಲಿತಾಂಶ / Result : PASS
`;

  const read = () => extractFromText(PUC, { documentKey: 'doc.marksheet_12' });

  it('reads the values through a label printed in Kannada alone', () => {
    const values = new Map(read().candidates.map((c) => [c.key, c.value]));
    expect(values.get('family.father_name')).toBe('MANJUNATHA');
    expect(values.get('family.mother_name')).toBe('SHOBHA');
    expect(values.get('identity.dob')).toBe('2006-05-05');
  });

  it('reads the register number and the student through a bilingual label', () => {
    const values = new Map(read().candidates.map((c) => [c.key, c.value]));
    expect(values.get('education.class_12.registration_number')).toBe('2024123456');
    expect(values.get('identity.full_name')).toBe('KIRAN KUMAR');
  });

  it('reads the board and the college as words, not as fragments', () => {
    const values = new Map(read().candidates.map((c) => [c.key, c.value]));
    expect(values.get('education.class_12.board_or_university')).toBe(
      'DEPARTMENT OF PRE-UNIVERSITY EDUCATION',
    );
    expect(values.get('education.class_12.institution')).toBe('SRI VIDYA PU COLLEGE');
  });

  it('reads the totals and the result', () => {
    const values = new Map(read().candidates.map((c) => [c.key, c.value]));
    expect(values.get('education.class_12.marks_obtained')).toBe('558');
    expect(values.get('education.class_12.max_marks')).toBe('600');
    expect(values.get('education.class_12.result_status')).toBe('PASS');
  });

  it('lists the six subjects it sat', () => {
    const subjects = read().candidates.find((c) => c.key === 'education.class_12.subjects');
    expect(subjects?.value.split(', ')).toHaveLength(6);
    expect(subjects?.value).toContain('PHYSICS');
    expect(subjects?.value).toContain('KANNADA');
  });
});

describe('marks tables as the reader actually returns them', () => {
  /*
   * Row shapes taken from the reader's output on the user's own cards, with the
   * names and numbers changed. Neither card prints a row the way the earlier
   * fixtures did:
   *
   *  - CBSE leads each row with a subject code and prints theory, internal
   *    assessment and total, then the total in words and a grade. The second
   *    last number is the internal assessment, not a maximum.
   *  - The 2nd PUC certificate repeats the register number and the exam month
   *    in every row, before the maximum and the marks.
   */
  const CBSE_ROWS = `
CENTRAL BOARD OF SECONDARY EDUCATION
SECONDARY SCHOOL EXAMINATION, 2020
This is to certify that R PRAVEEN KUMAR
Roll No. : 18100001
184 ENGLISH LNG & LIT. 070 020 090 NINETY A2
015 KANNADA 071 020 091 NINETY ONE A2
041 MATHEMATICS STANDARD 060 020 080 EIGHTY A2
086 SCIENCE - THEORY 050 020 070 SEVENTY B1
087 SOCIAL SCIENCE 075 020 095 NINETY FIVE A1
Ru Result : PASS
`;

  const PUC_ROWS = `
DEPARTMENT OF PRE-UNIVERSITY EDUCATION
Month/Year : APRIL 2022
Register No. : 800001
KANNADA 800001 APR2022 100 91 91 NINE ONE
ENGLISH 800001 APR2022 100 82 82 EIGHT TWO
PHYSICS 800001 APR2022 100 81 81 EIGHT ONE
CHEMISTRY 800001 APR2022 100 77 77 SEVEN SEVEN
MATHEMATICS 800001 APR2022 100 88 88 EIGHT EIGHT
BIOLOGY 800001 APR2022 100 90 90 NINE ZERO
Total Marks : 600 509 509
College Code No. : CC0001
College : SRI VIDYA PU COLLEGE, 2ND CROSS, TUMKUR
`;

  const cbse = () => extractFromText(CBSE_ROWS, { documentKey: 'doc.marksheet_10' });
  const puc = () => extractFromText(PUC_ROWS, { documentKey: 'doc.marksheet_12' });
  const value = (result: ReturnType<typeof cbse>, key: string) =>
    result.candidates.find((c) => c.key === key)?.value;

  it('reads a CBSE row behind its subject code', () => {
    const subjects = value(cbse(), 'education.class_10.subjects');
    expect(subjects?.split(', ')).toEqual([
      'ENGLISH LNG & LIT',
      'KANNADA',
      'MATHEMATICS STANDARD',
      'SCIENCE - THEORY',
      'SOCIAL SCIENCE',
    ]);
  });

  it('adds up CBSE’s totals, not its internal-assessment column', () => {
    // 90 + 91 + 80 + 70 + 95. CBSE prints no grand total, so this is the sum.
    expect(value(cbse(), 'education.class_10.marks_obtained')).toBe('426');
  });

  it('invents no maximum CBSE did not print', () => {
    expect(value(cbse(), 'education.class_10.max_marks')).toBeUndefined();
  });

  it('reads past the register number and the month printed in every PUC row', () => {
    const subjects = value(puc(), 'education.class_12.subjects');
    expect(subjects?.split(', ')).toHaveLength(6);
    expect(subjects).not.toMatch(/800001|APR2022/);
  });

  it('takes the maximum from a totals line, not the repeated total', () => {
    // "Total Marks : 600 509 509": the maximum, the marks in figures, the total.
    expect(value(puc(), 'education.class_12.marks_obtained')).toBe('509');
    expect(value(puc(), 'education.class_12.max_marks')).toBe('600');
  });

  it('reads the year from "Month/Year"', () => {
    expect(value(puc(), 'education.class_12.year_of_passing')).toBe('2022');
  });

  it('takes the college’s name, not its code, as the institution', () => {
    expect(value(puc(), 'education.class_12.institution')).toBe(
      'SRI VIDYA PU COLLEGE, 2ND CROSS, TUMKUR',
    );
  });
});

describe('each subject’s own marks', () => {
  /*
   * An entrance application asks for Physics, Chemistry and Mathematics by
   * name. The card prints them; they are read into a box each, where the vault
   * has one.
   */
  const PUC_ROWS = `
DEPARTMENT OF PRE-UNIVERSITY EDUCATION
Register No. : 800001
KANNADA 800001 APR2022 100 91 91 NINE ONE
ENGLISH 800001 APR2022 100 82 82 EIGHT TWO
PHYSICS 800001 APR2022 100 81 81 EIGHT ONE
CHEMISTRY 800001 APR2022 100 77 77 SEVEN SEVEN
MATHEMATICS 800001 APR2022 100 88 88 EIGHT EIGHT
BIOLOGY 800001 APR2022 100 90 90 NINE ZERO
Total Marks : 600 509 509
`;

  const CBSE_ROWS = `
CENTRAL BOARD OF SECONDARY EDUCATION
SECONDARY SCHOOL EXAMINATION, 2020
184 ENGLISH LNG & LIT. 070 020 090 NINETY A2
015 KANNADA 071 020 091 NINETY ONE A2
041 MATHEMATICS STANDARD 060 020 080 EIGHTY A2
086 SCIENCE - THEORY 050 020 070 SEVENTY B1
087 SOCIAL SCIENCE 075 020 095 NINETY FIVE A1
`;

  const values = (text: string, slot: FieldKey) =>
    new Map(extractFromText(text, { documentKey: slot }).candidates.map((c) => [c.key, c.value]));

  it('reads each PUC subject into its own box', () => {
    const v = values(PUC_ROWS, 'doc.marksheet_12');
    expect(v.get('education.class_12.marks_physics')).toBe('81');
    expect(v.get('education.class_12.marks_chemistry')).toBe('77');
    expect(v.get('education.class_12.marks_mathematics')).toBe('88');
    expect(v.get('education.class_12.marks_biology')).toBe('90');
    expect(v.get('education.class_12.marks_english')).toBe('82');
  });

  it('files the language a student sat under "language", whichever language it was', () => {
    expect(values(PUC_ROWS, 'doc.marksheet_12').get('education.class_12.marks_language')).toBe('91');
    const hindi = PUC_ROWS.replace('KANNADA', 'HINDI');
    expect(values(hindi, 'doc.marksheet_12').get('education.class_12.marks_language')).toBe('91');
  });

  it('reads CBSE’s subjects under the names CBSE gives them', () => {
    const v = values(CBSE_ROWS, 'doc.marksheet_10');
    expect(v.get('education.class_10.marks_english')).toBe('90');
    expect(v.get('education.class_10.marks_mathematics')).toBe('80');
    expect(v.get('education.class_10.marks_science')).toBe('70');
    expect(v.get('education.class_10.marks_social_science')).toBe('95');
    expect(v.get('education.class_10.marks_language')).toBe('91');
  });

  it('never files Social Science as Science', () => {
    const v = values(CBSE_ROWS, 'doc.marksheet_10');
    expect(v.get('education.class_10.marks_science')).not.toBe('95');
  });

  it('says which subjects it read and had no box for', () => {
    const commerce = PUC_ROWS.replace('PHYSICS', 'ACCOUNTANCY').replace('CHEMISTRY', 'BUSINESS STUDIES');
    const result = extractFromText(commerce, { documentKey: 'doc.marksheet_12' });
    expect(result.notes.join(' ')).toMatch(/ACCOUNTANCY/);
    expect(result.notes.join(' ')).toMatch(/BUSINESS STUDIES/);
    expect(result.notes.join(' ')).not.toMatch(/PHYSICS|MATHEMATICS/);
  });

  it('offers none of it as decided', () => {
    const result = extractFromText(PUC_ROWS, { documentKey: 'doc.marksheet_12' });
    expect(result.candidates.filter((c) => c.suggestChecked)).toEqual([]);
  });
});

describe('a subject name the reader damaged', () => {
  /*
   * Read off a real 2nd PUC card: the H of MATHEMATICS came back as a space and
   * a J. Five subjects were filed and the sixth — the one an engineering form
   * asks for first — was left in the list under a name nobody would search for.
   */
  const ROWS = `
DEPARTMENT OF PRE-UNIVERSITY EDUCATION
Register No. : 800001
KANNADA 800001 APR2022 100 91 91 NINE ONE
ENGLISH 800001 APR2022 100 82 82 EIGHT TWO
PHYSICS 800001 APR2022 100 81 81 EIGHT ONE
CHEMISTRY 800001 APR2022 100 77 77 SEVEN SEVEN
MAT JEMATICS 800001 APR2022 100 88 88 EIGHT EIGHT
BIOLOGY 800001 APR2022 100 90 90 NINE ZERO
Total Marks : 600 509 509
`;

  const read = (text: string) => {
    const result = extractFromText(text, { documentKey: 'doc.marksheet_12' });
    return {
      values: new Map(result.candidates.map((c) => [c.key, c.value])),
      notes: result.notes.join(' '),
    };
  };

  it('files the marks under the subject it plainly is', () => {
    expect(read(ROWS).values.get('education.class_12.marks_mathematics')).toBe('88');
  });

  it('saves the name as the card prints it, not as it was misread', () => {
    const subjects = read(ROWS).values.get('education.class_12.subjects');
    expect(subjects).toContain('MATHEMATICS');
    expect(subjects).not.toContain('JEMATICS');
  });

  it('mends one wrong letter in a long name, wherever it falls', () => {
    expect(read(ROWS.replace('CHEMISTRY', 'CHEMISTRV')).values.get('education.class_12.marks_chemistry')).toBe('77');
    expect(read(ROWS.replace('BIOLOGY', 'BI0LOGY')).values.get('education.class_12.marks_biology')).toBe('90');
  });

  it('reads through a stray mark the damage left inside the name', () => {
    // The same card, the same word, after the photograph was saved again: the
    // broken H came back as a mark and a J, and the whole row was thrown away
    // for not looking like a subject.
    const result = read(ROWS.replace('MAT JEMATICS', 'MAT!JEMATICS'));
    expect(result.values.get('education.class_12.marks_mathematics')).toBe('88');
    expect(result.values.get('education.class_12.subjects')).toContain('MATHEMATICS');
  });

  it('never mends one subject into another', () => {
    // Each of these is a real subject one or two letters from a boxed one.
    const physical = read(ROWS.replace('PHYSICS', 'PHYSICAL EDUCATION'));
    expect(physical.values.get('education.class_12.marks_physics')).toBeUndefined();
    expect(physical.notes).toMatch(/PHYSICAL EDUCATION/);

    const geology = read(ROWS.replace('BIOLOGY', 'GEOLOGY'));
    expect(geology.values.get('education.class_12.marks_biology')).toBeUndefined();
    expect(geology.notes).toMatch(/GEOLOGY/);
  });

  it('leaves a short name alone', () => {
    // "HINDU" is one letter from "HINDI"; five letters is too few to mend on.
    const result = read(ROWS.replace('KANNADA', 'HINDU'));
    expect(result.values.get('education.class_12.marks_language')).toBeUndefined();
  });
});
