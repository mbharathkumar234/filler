import { describe, expect, it } from 'vitest';

import { branchesFor, coursesFor, COURSES, suggestionsFor } from './courses';
import type { AcademicPath } from './pathway';

/**
 * The courses a student picks from (§ vault structure).
 *
 * A portal asks "Course" and "Branch" as free text or as a dropdown, and what
 * it wants is the name the university uses — "B.E. / B.Tech", "Computer
 * Science Engineering" — not whatever a person typed at midnight. The
 * catalogue exists so the vault holds that name once and every form gets the
 * same one.
 *
 * It is a list of suggestions, never a restriction: the field stays free text,
 * because no list of Indian degree titles is ever complete.
 */

const STUDENT: AcademicPath = {
  version: 1,
  state: 'karnataka',
  board10: 'cbse',
  afterTen: 'puc',
  stream: 'pcmb',
  now: 'undergraduate',
  degreeFamily: 'engineering',
  course: null,
  branch: null,
  entrance: ['kcet'],
  category: 'st',
  claims: ['371j'],
};

describe('the catalogue', () => {
  it('offers an engineering student the degree they are reading for', () => {
    const names = coursesFor('engineering', 'ug').map((course) => course.name);
    expect(names).toContain('B.E. / B.Tech');
    expect(names).not.toContain('MBBS');
  });

  it('offers a postgraduate their own degrees, not an undergraduate’s', () => {
    const names = coursesFor('engineering', 'pg').map((course) => course.name);
    expect(names).toContain('M.Tech');
    expect(names).not.toContain('B.E. / B.Tech');
  });

  it('knows the branches of a B.Tech, including the ones colleges added recently', () => {
    const branches = branchesFor('B.E. / B.Tech');
    expect(branches).toContain('Computer Science Engineering');
    expect(branches).toContain('Artificial Intelligence & Machine Learning');
    expect(branches).toContain('Electronics & Communication');
    expect(branches).toContain('Civil Engineering');
  });

  it('knows a medical, a commerce and an arts course too', () => {
    expect(coursesFor('medical', 'ug').map((c) => c.name)).toContain('MBBS');
    expect(coursesFor('commerce', 'ug').map((c) => c.name)).toContain('B.Com');
    expect(coursesFor('arts', 'ug').map((c) => c.name)).toContain('BA');
  });

  it('answers with nothing for a course it does not know, rather than guessing', () => {
    expect(branchesFor('Bachelor of Something Else')).toEqual([]);
  });

  it('names every course once, and gives every branch a course', () => {
    const names = COURSES.map((course) => course.name);
    expect(new Set(names).size).toBe(names.length);
    for (const course of COURSES) {
      for (const branch of course.branches ?? []) {
        expect(branch.trim(), course.name).not.toBe('');
      }
    }
  });
});

describe('what the editor suggests for a field', () => {
  it('suggests this student’s own degree under their course box', () => {
    const suggestions = suggestionsFor('education.undergraduate.course', STUDENT);
    expect(suggestions).toContain('B.E. / B.Tech');
    expect(suggestions).not.toContain('MBBS');
  });

  it('suggests the branches of the course they picked', () => {
    const picked: AcademicPath = { ...STUDENT, course: 'B.E. / B.Tech' };
    expect(suggestionsFor('education.undergraduate.branch', picked)).toContain(
      'Computer Science Engineering',
    );
  });

  it('suggests every branch of the family when no course has been picked', () => {
    expect(suggestionsFor('education.undergraduate.branch', STUDENT).length).toBeGreaterThan(10);
  });

  it('suggests postgraduate degrees under the postgraduate block', () => {
    const pg: AcademicPath = { ...STUDENT, now: 'postgraduate' };
    expect(suggestionsFor('education.postgraduate.course', pg)).toContain('M.Tech');
  });

  it('suggests nothing for a field that is not a course or a branch', () => {
    expect(suggestionsFor('identity.full_name', STUDENT)).toEqual([]);
    expect(suggestionsFor('education.class_10.course', STUDENT)).toEqual([]);
  });

  it('suggests nothing when the questions were never answered', () => {
    expect(suggestionsFor('education.undergraduate.course', null)).toEqual([]);
  });

  it('falls back to every family when one was not named', () => {
    const unnamed: AcademicPath = { ...STUDENT, degreeFamily: null };
    const suggestions = suggestionsFor('education.undergraduate.course', unnamed);
    expect(suggestions).toContain('B.E. / B.Tech');
    expect(suggestions).toContain('B.Com');
  });
});
