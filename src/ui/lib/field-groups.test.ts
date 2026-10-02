import { describe, expect, it } from 'vitest';

import { FIELD_KEYS, isDocumentKey } from '@/matching/taxonomy';
import { DOCUMENT_GROUPS, DOCUMENT_KEYS, FIELD_GROUPS, labelFor } from './field-groups';

/**
 * The vault's shape, as the editor shows it.
 *
 * The taxonomy is flat and append-only, so a document key added tomorrow
 * belongs to no folder until someone puts it in one. These tests are what
 * notices: a slot missing from every group is a document the user can never
 * add, and a slot in two groups is one they can add twice.
 */
describe('the document folders', () => {
  const grouped = DOCUMENT_GROUPS.flatMap((group) => group.keys);

  it('gives every document slot exactly one folder', () => {
    const counts = new Map<string, number>();
    for (const key of grouped) counts.set(key, (counts.get(key) ?? 0) + 1);

    const documents = FIELD_KEYS.filter(isDocumentKey);
    expect([...counts].filter(([, n]) => n > 1).map(([key]) => key)).toEqual([]);
    expect(documents.filter((key) => !counts.has(key))).toEqual([]);
  });

  it('holds nothing but document slots', () => {
    expect(grouped.filter((key) => !isDocumentKey(key))).toEqual([]);
  });

  it('names each level-specific slot by its level, so two of a kind never look alike', () => {
    // A student holds a study certificate from school and another from PUC.
    // Two slots both labelled "Study certificate" would be a coin toss.
    const levelled = DOCUMENT_KEYS.filter((key) => /_1[012]$/.test(key));
    expect(levelled.length).toBeGreaterThan(5);
    for (const key of levelled) {
      expect(labelFor(key), key).toMatch(/Class 1[012]|PUC/);
    }
  });

  it('keeps the RD numbers with the other text fields, not with the documents', () => {
    // They are printed on a certificate, so they read like documents; a portal
    // asks for them in a text box, so this is where the user must find them.
    const eligibility = FIELD_GROUPS.find((group) => group.id === 'eligibility');
    expect(eligibility?.keys).toContain('eligibility.caste_certificate_number');
    expect(eligibility?.keys).toContain('eligibility.income_certificate_number');
    expect(eligibility?.keys).toContain('eligibility.article_371j_number');
  });

  it('puts the documents every form asks for first', () => {
    expect(DOCUMENT_KEYS.slice(0, 3)).toEqual([
      'doc.photo',
      'doc.signature',
      'doc.thumb_impression',
    ]);
  });
});
