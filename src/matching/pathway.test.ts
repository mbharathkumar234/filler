import { describe, expect, it } from 'vitest';

import { FIELD_KEYS, isFieldKey, markSubjectOf } from './taxonomy';
import {
  defaultPath,
  describePath,
  documentKeysFor,
  fieldKeysFor,
  parsePath,
  qualificationPrefixesFor,
  type AcademicPath,
} from './pathway';

/**
 * What a person's own education means for their vault (§ vault structure).
 *
 * The vault used to offer everybody the same seven qualification blocks and
 * every document slot the taxonomy has. A Karnataka student who went CBSE
 * Class 10 → PUC → B.Tech scrolled past Diploma, Postgraduate, Professional
 * degree and Doctorate to reach their bank details, and past a folder of
 * papers they will never hold.
 *
 * These rules decide what such a person is *offered*. They never decide what
 * is possible: a key that already holds a value is shown whatever they say,
 * and the panels keep a "show everything" control.
 */

/** The path this design was held against, from the user's own history. */
const STUDENT: AcademicPath = {
  version: 1,
  state: 'karnataka',
  board10: 'cbse',
  afterTen: 'puc',
  stream: 'pcmb',
  now: 'undergraduate',
  degreeFamily: 'engineering',
  course: 'B.E. / B.Tech',
  branch: 'Computer Science Engineering',
  entrance: ['kcet'],
  category: 'st',
  claims: ['371j', 'income'],
};

const DIPLOMA_STUDENT: AcademicPath = {
  ...STUDENT,
  afterTen: 'diploma',
  stream: null,
  entrance: [],
  category: 'gm',
  claims: [],
};

describe('the qualifications a path implies', () => {
  it('gives the student school, PUC and the degree they are reading for', () => {
    expect(qualificationPrefixesFor(STUDENT)).toEqual([
      'education.class_10.',
      'education.class_12.',
      'education.undergraduate.',
    ]);
  });

  it('gives a diploma student the diploma instead of PUC', () => {
    const prefixes = qualificationPrefixesFor(DIPLOMA_STUDENT);
    expect(prefixes).toContain('education.diploma.');
    expect(prefixes).not.toContain('education.class_12.');
  });

  it('adds the postgraduate block only once someone is reading for one', () => {
    expect(qualificationPrefixesFor({ ...STUDENT, now: 'postgraduate' })).toContain(
      'education.postgraduate.',
    );
    expect(qualificationPrefixesFor(STUDENT)).not.toContain('education.postgraduate.');
  });

  it('never offers a doctorate to somebody who has not said they are doing one', () => {
    expect(qualificationPrefixesFor(STUDENT)).not.toContain('education.phd.');
  });

  it('gives a school leaver school alone', () => {
    const leaver: AcademicPath = { ...STUDENT, afterTen: 'none', now: 'class_12', entrance: [] };
    expect(qualificationPrefixesFor(leaver)).toEqual(['education.class_10.']);
  });
});

describe('the documents a path implies', () => {
  const student = documentKeysFor(STUDENT);

  it('always offers what every form asks for', () => {
    for (const key of ['doc.photo', 'doc.signature', 'doc.aadhaar_card', 'doc.marksheet_10']) {
      expect(student, key).toContain(key);
    }
  });

  it('offers the PUC papers, and the KCET ones because that exam was named', () => {
    expect(student).toContain('doc.marksheet_12');
    expect(student).toContain('doc.entrance_rank_card');
    expect(student).toContain('doc.seat_allotment_letter');
  });

  it('offers the certificates their category and claims rest on, and no others', () => {
    expect(student).toContain('doc.caste_certificate');
    expect(student).toContain('doc.article_371j_certificate');
    expect(student).toContain('doc.income_certificate');
    expect(student).not.toContain('doc.disability_certificate');
  });

  it('leaves out the entrance folder for somebody who sat no entrance exam', () => {
    const documents = documentKeysFor(DIPLOMA_STUDENT);
    expect(documents).not.toContain('doc.entrance_rank_card');
    expect(documents).not.toContain('doc.admission_order');
  });

  it('offers no caste certificate to a general-merit applicant', () => {
    expect(documentKeysFor({ ...STUDENT, category: 'gm', claims: [] })).not.toContain(
      'doc.caste_certificate',
    );
  });

  it('offers the papers the course itself issues, once there is a course', () => {
    // Fourth year, seventh semester: these are the ones this person is asked
    // for by a scholarship or an internship, and had nowhere to put.
    expect(student).toContain('doc.semester_marksheet');
    expect(student).toContain('doc.bonafide_certificate');
    expect(student).toContain('doc.college_id_card');

    const leaver = documentKeysFor({ ...STUDENT, afterTen: 'none', now: 'class_12' });
    expect(leaver).not.toContain('doc.semester_marksheet');
  });

  it('offers the Form-D a Karnataka ST applicant is asked for, and not to others', () => {
    expect(student).toContain('doc.caste_certificate_form_d');
    expect(documentKeysFor({ ...STUDENT, state: null })).not.toContain(
      'doc.caste_certificate_form_d',
    );
    expect(documentKeysFor({ ...STUDENT, category: 'obc' })).toContain('doc.obc_certificate');
    expect(documentKeysFor({ ...STUDENT, category: 'ews' })).toContain('doc.ews_certificate');
  });

  it('offers what a student collects beside their marks', () => {
    expect(student).toContain('doc.resume');
    expect(student).toContain('doc.internship_certificate');
    expect(student).toContain('doc.hackathon_certificate');
    expect(student).toContain('doc.project_report');
  });

  it('offers a sports or NCC certificate only to somebody claiming one', () => {
    expect(student).not.toContain('doc.sports_certificate');
    expect(student).not.toContain('doc.ncc_certificate');

    const cadet = documentKeysFor({ ...STUDENT, claims: ['ncc', 'sports'] });
    expect(cadet).toContain('doc.ncc_certificate');
    expect(cadet).toContain('doc.sports_certificate');
  });

  it('offers the trade papers to somebody who went to an ITI, and nobody else', () => {
    const trainee = documentKeysFor({ ...STUDENT, afterTen: 'iti', now: 'iti' });
    expect(trainee).toContain('doc.iti_certificate');
    expect(student).not.toContain('doc.iti_certificate');
  });

  it('holds back the degree certificate until there is a degree', () => {
    // Fourth year, seventh semester: the marks cards exist, the degree does not.
    expect(student).not.toContain('doc.degree_certificate');
    expect(documentKeysFor({ ...STUDENT, now: 'graduated' })).toContain('doc.degree_certificate');
  });
});

describe('the fields a path implies', () => {
  const student = fieldKeysFor(STUDENT);

  it('keeps everything a form asks everybody', () => {
    for (const key of ['identity.full_name', 'contact.email', 'bank.ifsc', 'id.aadhaar']) {
      expect(student, key).toContain(key);
    }
  });

  it('narrows reservation to the claims actually made', () => {
    expect(student).toContain('eligibility.caste');
    expect(student).toContain('eligibility.caste_certificate_number');
    expect(student).toContain('eligibility.article_371j_number');
    expect(student).toContain('eligibility.income_certificate_number');

    expect(student).not.toContain('eligibility.ews');
    expect(student).not.toContain('eligibility.pwbd');
    expect(student).not.toContain('eligibility.ncc');
  });

  it('asks a PwBD applicant the questions that claim needs', () => {
    const pwbd = fieldKeysFor({ ...STUDENT, claims: ['pwbd'] });
    expect(pwbd).toContain('eligibility.disability_percentage');
    expect(pwbd).toContain('eligibility.udid');
  });

  it('asks for the entrance numbers when an entrance exam was named', () => {
    expect(student).toContain('entrance.registration_number');
    expect(student).toContain('entrance.rank');
    expect(fieldKeysFor({ ...STUDENT, entrance: [] })).not.toContain('entrance.rank');
  });

  it('asks which semester somebody is in, once they are in one', () => {
    expect(student).toContain('education.undergraduate.semester');
    expect(student).toContain('education.undergraduate.year_of_study');
  });

  it('asks the 371(J) claim itself, not only the number on its certificate', () => {
    expect(student).toContain('eligibility.article_371j');
    expect(fieldKeysFor({ ...STUDENT, claims: [] })).not.toContain('eligibility.article_371j');
  });

  it('never offers the level-less education block, which nobody fills any more', () => {
    expect([...student].filter((key) => key.startsWith('education[]'))).toEqual([]);
  });
});

describe('the rules as a whole', () => {
  const PATHS: AcademicPath[] = [
    STUDENT,
    DIPLOMA_STUDENT,
    defaultPath(),
    { ...STUDENT, afterTen: 'iti', now: 'iti' },
    { ...STUDENT, now: 'graduated', category: 'ews', claims: ['domicile', 'sports', 'ncc', 'nss'] },
    { ...STUDENT, now: 'postgraduate', entrance: ['jee', 'cuet'], category: 'obc' },
  ];

  it('invents no key: everything offered is in the taxonomy', () => {
    for (const path of PATHS) {
      for (const key of [...documentKeysFor(path), ...fieldKeysFor(path)]) {
        expect(isFieldKey(key), `${key} is not a taxonomy key`).toBe(true);
      }
    }
  });

  it('offers documents only from the document half, and fields only from the other', () => {
    for (const path of PATHS) {
      for (const key of documentKeysFor(path)) expect(key.startsWith('doc.'), key).toBe(true);
      for (const key of fieldKeysFor(path)) expect(key.startsWith('doc.'), key).toBe(false);
    }
  });

  it('offers a beginner enough to fill an ordinary form', () => {
    // The default path is what somebody who skips a question has.
    const fields = fieldKeysFor(defaultPath());
    expect(fields.size).toBeGreaterThan(30);
    expect(fields.size).toBeLessThan(FIELD_KEYS.length);
  });
});

describe('storing and reading a path back', () => {
  it('reads back exactly what was stored', () => {
    expect(parsePath(JSON.parse(JSON.stringify(STUDENT)))).toEqual(STUDENT);
  });

  it('treats anything that is not a path as no path at all', () => {
    // It comes out of the vault, and a half-understood answer would shape the
    // whole editor. Nothing here is repaired into something plausible.
    for (const value of [
      null,
      'karnataka',
      42,
      {},
      { ...STUDENT, version: 2 },
      { ...STUDENT, afterTen: 'college' },
      { ...STUDENT, category: 'unknown' },
      { ...STUDENT, claims: 'income' },
      { ...STUDENT, entrance: 'kcet' },
    ]) {
      expect(parsePath(value), JSON.stringify(value)).toBeNull();
    }
  });

  it('drops a list entry it does not know rather than the whole path', () => {
    // Forward compatibility: a path written by a later build must still open,
    // without the exam or the claim this build has no rule for.
    const parsed = parsePath({
      ...STUDENT,
      entrance: ['kcet', 'some-exam-from-2030'],
      claims: ['371j', 'a-claim-from-2030'],
    });
    expect(parsed?.entrance).toEqual(['kcet']);
    expect(parsed?.claims).toEqual(['371j']);
  });
});

describe('saying the path back to the person', () => {
  it('reads as a sentence they recognise', () => {
    const summary = describePath(STUDENT);
    expect(summary).toContain('CBSE');
    expect(summary).toContain('PUC');
    expect(summary).toContain('KCET');
    expect(summary).toContain('ST');
    expect(summary).toContain('371(J)');
  });

  it('says something for a path with nothing claimed', () => {
    expect(describePath(defaultPath()).length).toBeGreaterThan(0);
  });
});

describe('the subjects a stream implies', () => {
  /*
   * A marks card has a row per subject, and an entrance application asks for
   * those marks by name. The vault offers a box for each subject a person sat —
   * and only those: a Commerce student scrolling past "Physics marks" is the
   * clutter this whole module exists to remove.
   */
  const marks = (path: AcademicPath) =>
    [...fieldKeysFor(path)]
      .filter((key) => key.startsWith('education.class_12.') && markSubjectOf(key) !== null)
      .sort();

  it('offers a PCMB student all four sciences, and the two languages', () => {
    expect(marks(STUDENT)).toEqual([
      'education.class_12.marks_biology',
      'education.class_12.marks_chemistry',
      'education.class_12.marks_english',
      'education.class_12.marks_language',
      'education.class_12.marks_mathematics',
      'education.class_12.marks_physics',
    ]);
  });

  it('offers a PCM student no biology, and a PCB student no mathematics', () => {
    expect(marks({ ...STUDENT, stream: 'pcm' })).not.toContain('education.class_12.marks_biology');
    expect(marks({ ...STUDENT, stream: 'pcb' })).not.toContain('education.class_12.marks_mathematics');
    expect(marks({ ...STUDENT, stream: 'pcb' })).toContain('education.class_12.marks_biology');
  });

  it('offers computer science to the stream that sat it', () => {
    expect(marks({ ...STUDENT, stream: 'pcm-cs' })).toContain('education.class_12.marks_computer_science');
    expect(marks(STUDENT)).not.toContain('education.class_12.marks_computer_science');
  });

  it('offers a Commerce or Arts student the languages, and no science', () => {
    for (const stream of ['commerce', 'arts'] as const) {
      expect(marks({ ...STUDENT, stream }), stream).toEqual([
        'education.class_12.marks_english',
        'education.class_12.marks_language',
      ]);
    }
  });

  it('offers every subject when the stream is not known', () => {
    // No answer is not an answer of "none": the whole catalogue for the level.
    expect(marks({ ...STUDENT, stream: null })).toContain('education.class_12.marks_physics');
    expect(marks({ ...STUDENT, stream: 'other' })).toContain('education.class_12.marks_biology');
  });

  it('offers the Class 10 subjects to everyone, whatever they read afterwards', () => {
    const ten = [...fieldKeysFor({ ...STUDENT, stream: 'commerce' })].filter(
      (key) => key.startsWith('education.class_10.') && markSubjectOf(key) !== null,
    );
    expect(ten.sort()).toEqual([
      'education.class_10.marks_english',
      'education.class_10.marks_language',
      'education.class_10.marks_mathematics',
      'education.class_10.marks_science',
      'education.class_10.marks_social_science',
    ]);
  });
});

describe('the total, which is not a subject', () => {
  it('keeps "marks obtained" for every stream', () => {
    // `marks_obtained` begins like a subject's key. A rule that matched on the
    // beginning alone hid the total from everyone who sat no such subject.
    for (const stream of ['pcm', 'pcb', 'pcmb', 'pcm-cs', 'commerce', 'arts', 'other', null] as const) {
      expect(fieldKeysFor({ ...STUDENT, stream }), String(stream)).toContain(
        'education.class_12.marks_obtained',
      );
    }
  });
});
