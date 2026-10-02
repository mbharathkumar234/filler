import { describe, expect, it } from 'vitest';

import type { AcademicPath } from '@/matching/pathway';
import { DOCUMENT_GROUPS, FIELD_GROUPS } from './field-groups';
import { documentGroupsFor, fieldGroupsFor, hiddenCount } from './vault-shape';

/** The path this design was held against (§ vault structure). */
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

const NOTHING: ReadonlySet<string> = new Set();

const titles = (groups: { title: string }[]) => groups.map((group) => group.title);
const ids = (groups: { id: string }[]) => groups.map((group) => group.id);

describe('the blocks one person is offered', () => {
  it('offers school, PUC and the degree — and not the four they never took', () => {
    const shown = ids(fieldGroupsFor(STUDENT, NOTHING));

    expect(shown).toContain('edu-class-10');
    expect(shown).toContain('edu-class-12');
    expect(shown).toContain('edu-ug');

    for (const absent of ['edu-diploma', 'edu-pg', 'edu-professional', 'edu-phd', 'education']) {
      expect(shown, absent).not.toContain(absent);
    }
  });

  it('keeps every block a form asks everybody', () => {
    const shown = ids(fieldGroupsFor(STUDENT, NOTHING));
    for (const id of ['identity', 'family', 'contact', 'ids', 'bank', 'address-permanent']) {
      expect(shown, id).toContain(id);
    }
  });

  it('narrows reservation to the three questions this person is actually asked', () => {
    const eligibility = fieldGroupsFor(STUDENT, NOTHING).find((g) => g.id === 'eligibility');

    expect(eligibility?.keys).toContain('eligibility.caste');
    expect(eligibility?.keys).toContain('eligibility.article_371j_number');
    expect(eligibility?.keys).not.toContain('eligibility.ncc');
    // Twenty-one questions in the catalogue; a handful for this person.
    expect(eligibility!.keys.length).toBeLessThan(8);
  });

  it('names a block the way this person’s own board does', () => {
    const shown = titles(fieldGroupsFor(STUDENT, NOTHING));
    expect(shown).toContain('Class 10 (CBSE)');
    expect(shown).toContain('PUC (Class 12)');
  });

  it('never gives a folder and a block the same name', () => {
    // One page with two "Class 10" sections is a page nobody trusts.
    const all = [
      ...titles(fieldGroupsFor(STUDENT, NOTHING)),
      ...titles(documentGroupsFor(STUDENT, NOTHING)),
    ];
    expect(new Set(all).size).toBe(all.length);
  });
});

describe('the folders one person is offered', () => {
  it('offers the PUC and KCET papers, and no ITI or diploma folder', () => {
    const folders = documentGroupsFor(STUDENT, NOTHING);
    const keys = folders.flatMap((group) => group.keys);

    expect(ids(folders)).toContain('docs-class-12');
    expect(ids(folders)).toContain('docs-entrance');
    expect(keys).toContain('doc.entrance_rank_card');
    expect(keys).not.toContain('doc.degree_certificate');
  });

  it('keeps the caste folder to the certificates this person holds', () => {
    const reservation = documentGroupsFor(STUDENT, NOTHING).find(
      (group) => group.id === 'docs-reservation',
    );
    // ST in Karnataka: the ordinary certificate, the Form-D that KEA asks for
    // beside it, the income certificate claimed, and the 371(J) annexure.
    expect(reservation?.keys).toEqual([
      'doc.caste_certificate',
      'doc.caste_certificate_form_d',
      'doc.income_certificate',
      'doc.article_371j_certificate',
    ]);
  });

  it('drops a folder whose every slot was narrowed away', () => {
    const general: AcademicPath = { ...STUDENT, category: 'gm', claims: [], entrance: [] };
    const shown = ids(documentGroupsFor(general, NOTHING));
    expect(shown).not.toContain('docs-reservation');
    expect(shown).not.toContain('docs-entrance');
  });

  it('opens what an answer asked for, and folds what is merely on offer', () => {
    const folders = documentGroupsFor(STUDENT, NOTHING);
    const open = folders.filter((group) => group.optional !== true).map((group) => group.id);
    const folded = folders.filter((group) => group.optional === true).map((group) => group.id);

    // Asked for: named an exam, named a category, said they are in college.
    expect(open).toContain('docs-entrance');
    expect(open).toContain('docs-reservation');
    expect(open).toContain('docs-college');
    // On offer: nobody is asked whether they have been to a hackathon.
    expect(folded).toEqual(['docs-work', 'docs-skills', 'docs-achievements', 'docs-service']);
  });
});

describe('what a path can never do', () => {
  it('never hides a block that already holds a value', () => {
    // The clause that makes a wrong answer cost a click and not a record.
    const filled = new Set(['education.phd.institution', 'doc.disability_certificate']);

    expect(ids(fieldGroupsFor(STUDENT, filled))).toContain('edu-phd');
    const documents = documentGroupsFor(STUDENT, filled).flatMap((group) => group.keys);
    expect(documents).toContain('doc.disability_certificate');
  });

  it('shows the whole catalogue when the questions were skipped', () => {
    expect(fieldGroupsFor(null, NOTHING)).toEqual(FIELD_GROUPS);
    expect(documentGroupsFor(null, NOTHING)).toEqual(DOCUMENT_GROUPS);
    expect(hiddenCount(null, NOTHING)).toBe(0);
  });

  it('invents no group and no key: everything shown is in the catalogue', () => {
    const catalogue = new Set([
      ...FIELD_GROUPS.flatMap((group) => group.keys),
      ...DOCUMENT_GROUPS.flatMap((group) => group.keys),
    ]);

    for (const group of [...fieldGroupsFor(STUDENT, NOTHING), ...documentGroupsFor(STUDENT, NOTHING)]) {
      for (const key of group.keys) expect(catalogue.has(key), key).toBe(true);
    }
  });

  it('can say how much it is holding back, for the control that reveals it', () => {
    expect(hiddenCount(STUDENT, NOTHING)).toBeGreaterThan(50);
  });
});
