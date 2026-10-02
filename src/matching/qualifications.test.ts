import { describe, expect, it } from 'vitest';

import type { FieldKey } from './taxonomy';
import { QUALIFICATION_PREFIXES, answerLevellessEducation } from './qualifications';

/**
 * A question that names no qualification (§ vault structure).
 *
 * The vault used to hold a separate "any qualification" block, so a person who
 * had typed their PUC marks into the Class 12 block typed them again into the
 * generic one. It is gone; a level-less question is answered from the
 * qualification the person most recently earned.
 */

function values(entries: Record<string, string>): Map<string, string> {
  return new Map(Object.entries(entries));
}

describe('answering a question that names no qualification', () => {
  it('answers from the most recent qualification there is', () => {
    const filled = answerLevellessEducation(
      values({
        'education.class_10.roll_number': '1234567',
        'education.class_12.roll_number': 'PUC-99',
      }),
    );
    expect(filled.get('education[].roll_number')).toBe('PUC-99');
  });

  it('never overwrites a value the user typed themselves', () => {
    const filled = answerLevellessEducation(
      values({
        'education[].roll_number': 'typed by hand',
        'education.class_12.roll_number': 'PUC-99',
      }),
    );
    expect(filled.get('education[].roll_number')).toBe('typed by hand');
  });

  it('takes the whole answer from one qualification, never a mixture of two', () => {
    // Half a degree and half a school record is a record nobody holds: the
    // board would be the university and the roll number the school's.
    const filled = answerLevellessEducation(
      values({
        'education.class_12.roll_number': 'PUC-99',
        'education.class_12.board_or_university': 'Department of Pre-University Education',
        'education.undergraduate.board_or_university': 'VTU',
      }),
    );
    expect(filled.get('education[].board_or_university')).toBe('VTU');
    expect(filled.has('education[].roll_number')).toBe(false);
  });

  it('leaves the map alone when no qualification has been filled in', () => {
    const before = values({ 'identity.full_name': 'A' });
    expect([...answerLevellessEducation(before)]).toEqual([...before]);
  });

  it('copies nothing but education fields', () => {
    const filled = answerLevellessEducation(values({ 'education.class_12.roll_number': 'PUC-99' }));
    for (const key of filled.keys()) {
      expect(key === 'education[].roll_number' || key.startsWith('education.')).toBe(true);
    }
  });

  it('ranks the qualifications from the most recent down to school', () => {
    expect(QUALIFICATION_PREFIXES[0]).toBe('education.phd.');
    expect(QUALIFICATION_PREFIXES[QUALIFICATION_PREFIXES.length - 1]).toBe('education.class_10.');
  });

  it('only ever writes keys the taxonomy has', () => {
    const every: Record<string, string> = {};
    for (const prefix of QUALIFICATION_PREFIXES) every[`${prefix}made_up_field`] = 'x';
    const filled = answerLevellessEducation(values(every));
    expect([...filled.keys()].some((k) => k === 'education[].made_up_field')).toBe(false);
  });

  it('is a copy: the caller’s own map is not changed', () => {
    const before = values({ 'education.class_12.roll_number': 'PUC-99' });
    answerLevellessEducation(before);
    expect(before.has('education[].roll_number')).toBe(false);
  });
});

describe('the prefixes themselves', () => {
  it('names a real block for every prefix', () => {
    for (const prefix of QUALIFICATION_PREFIXES) {
      const key = `${prefix}roll_number` as FieldKey;
      expect(key.startsWith('education.'), prefix).toBe(true);
    }
  });
});
