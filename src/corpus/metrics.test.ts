import { describe, expect, it } from 'vitest';

import { judge, tally, combine, type FieldOutcome } from './metrics';

/**
 * How the bench scores a field (U0.M5, `MASTER_PROMPT.md`).
 *
 * `expected` is the field's `data-expect`: a key, `unknown` for a field nothing
 * should fill, or `ambiguous` for a field even a careful person could not
 * decide — excluded from accuracy and counted on its own. The thresholds are
 * the product's own: 0.85 fills without a flag, 0.5 fills with one.
 */

const field = (expected: string | null, actual: string, confidence: number): FieldOutcome => ({ expected, actual, confidence });

describe('one field', () => {
  it('is right when the key is the expected one at a confidence that fills', () => {
    expect(judge(field('identity.full_name', 'identity.full_name', 0.9))).toEqual({ verdict: 'correct', confident: true });
    expect(judge(field('identity.full_name', 'identity.full_name', 0.6))).toEqual({ verdict: 'correct', confident: false });
  });

  it('is unmapped when nothing filled it, or too unsurely to fill', () => {
    expect(judge(field('identity.full_name', 'unknown', 0))).toEqual({ verdict: 'unmapped', confident: false });
    expect(judge(field('identity.full_name', 'identity.full_name', 0.4))).toEqual({ verdict: 'unmapped', confident: false });
  });

  it('is a mismatch when another key would be filled — a confident one when nothing would flag it', () => {
    expect(judge(field('identity.full_name', 'family.father_name', 0.9))).toEqual({ verdict: 'mismatch', confident: true });
    expect(judge(field('identity.full_name', 'family.father_name', 0.6))).toEqual({ verdict: 'mismatch', confident: false });
  });

  it('is a mismatch when a field nothing should fill is filled', () => {
    expect(judge(field('unknown', 'contact.email', 0.9))).toEqual({ verdict: 'mismatch', confident: true });
    expect(judge(field('unknown', 'unknown', 0))).toEqual({ verdict: 'left-alone', confident: false });
    expect(judge(field('unknown', 'contact.email', 0.3))).toEqual({ verdict: 'left-alone', confident: false });
  });

  it('is set aside when ambiguous, and counted as unlabelled when not labelled at all', () => {
    expect(judge(field('ambiguous', 'contact.email', 0.9)).verdict).toBe('ambiguous');
    expect(judge(field(null, 'contact.email', 0.9)).verdict).toBe('unlabelled');
  });
});

describe('a page, and many', () => {
  const page = [
    field('identity.full_name', 'identity.full_name', 0.95),
    field('contact.email', 'contact.email', 0.7),
    field('contact.mobile', 'unknown', 0),
    field('identity.dob', 'family.father_name', 0.9),
    field('unknown', 'unknown', 0),
    field('ambiguous', 'contact.email', 0.9),
    field(null, 'contact.email', 0.9),
  ];

  it('counts every kind of outcome', () => {
    expect(tally(page)).toEqual({
      fields: 7,
      labelled: 6,
      unlabelled: 1,
      ambiguous: 1,
      mappable: 4,
      correct: 2,
      correctConfident: 1,
      unmapped: 1,
      mismatched: 1,
      confidentMismatches: 1,
      leftAlone: 1,
    });
  });

  it('reports a planted wrong mapping, so the bench can be trusted to catch one', () => {
    const clean = tally([field('identity.dob', 'identity.dob', 0.95)]);
    const planted = tally([field('identity.dob', 'identity.full_name', 0.95)]);
    expect(clean.confidentMismatches).toBe(0);
    expect(planted.confidentMismatches).toBe(1);
  });

  it('adds pages together', () => {
    const total = combine([tally(page), tally(page)]);
    expect(total.fields).toBe(14);
    expect(total.confidentMismatches).toBe(2);
    expect(combine([])).toEqual(tally([]));
  });
});
