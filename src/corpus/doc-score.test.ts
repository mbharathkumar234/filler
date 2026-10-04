import { describe, expect, it } from 'vitest';

import { scoreDocument, totalScore, type DocAnswer } from './doc-score';

/**
 * Scoring a document reading against its owner's answer key (U0.M7,
 * `MASTER_PROMPT.md`). The answer key and the reading hold the person's real
 * values; the score holds counts and field names only, so it can be shared and
 * committed. Every value below is a canary.
 */

const ANSWER: DocAnswer = {
  file: 'CANARY-FILE-name-of-a-person.jpg',
  slot: 'doc.marksheet_10',
  fields: {
    'identity.full_name': 'CANARY NAME',
    'identity.dob': '1999-01-02',
    'education.class_10.institution': { contains: 'CANARY SCHOOL' },
    'education.class_10.marks_obtained': '512',
  },
};

const READ = [
  { key: 'identity.full_name', value: 'canary name' },
  { key: 'identity.dob', value: '1999-02-01' },
  { key: 'education.class_10.institution', value: '99999-CANARY SCHOOL SAMPLE ROAD' },
  { key: 'family.mother_name', value: 'CANARY MOTHER' },
];

describe('one document', () => {
  it('counts each field right, wrong or missing, by its key', () => {
    expect(scoreDocument(ANSWER, READ)).toEqual({
      slot: 'doc.marksheet_10',
      fields: 4,
      right: 2,
      wrong: ['identity.dob'],
      missing: ['education.class_10.marks_obtained'],
    });
  });

  it('holds no value and no file name — only counts and field names', () => {
    const text = JSON.stringify(scoreDocument(ANSWER, READ));
    for (const secret of ['CANARY', 'canary', '1999', '512', '99999', 'name-of-a-person']) {
      expect(text, secret).not.toContain(secret);
    }
  });
});

describe('every document', () => {
  it('adds up, naming a slot twice when two documents share it', () => {
    const one = scoreDocument(ANSWER, READ);
    const total = totalScore([one, one]);
    expect(total).toEqual({
      documents: [
        { ...one, slot: 'doc.marksheet_10' },
        { ...one, slot: 'doc.marksheet_10 (2)' },
      ],
      fields: 8,
      right: 4,
      accuracy: 0.5,
    });
  });
});
