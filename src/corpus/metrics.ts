/**
 * How the bench scores a field and a page (U0.M5, `MASTER_PROMPT.md`).
 *
 * A field's `data-expect` is its expected key, `unknown` for a field nothing
 * should fill, or `ambiguous` for one even a careful person could not decide —
 * set aside from accuracy and counted on its own. The thresholds are the
 * product's own (`CONFIDENCE`): at 0.85 a value is filled without a flag; from
 * 0.5 it is filled and flagged for review; below 0.5 the box is left empty.
 *
 * A confident mismatch — the wrong key, filled without a flag — is the number
 * that must stay at zero: it is the one mistake a person reviewing the form is
 * not prompted to catch. Pure.
 */

import { CONFIDENCE } from '@/shared/types';

export interface FieldOutcome {
  /** The field's `data-expect`, or null when it has none. */
  expected: string | null;
  /** The key the matcher chose, or `unknown`. */
  actual: string;
  confidence: number;
}

export type Verdict = 'correct' | 'unmapped' | 'mismatch' | 'left-alone' | 'ambiguous' | 'unlabelled';

export interface Judgement {
  verdict: Verdict;
  /** Filled without a flag (≥ 0.85). */
  confident: boolean;
}

export interface Tally {
  fields: number;
  /** Fields with a `data-expect`, ambiguous ones included. */
  labelled: number;
  unlabelled: number;
  ambiguous: number;
  /** Fields whose expected answer is a key: the denominator of accuracy. */
  mappable: number;
  correct: number;
  /** Correct and filled without a flag. */
  correctConfident: number;
  unmapped: number;
  /** A wrong key filled, or any key filled into a field nothing should fill. */
  mismatched: number;
  /** Mismatches filled without a flag. Must be zero. */
  confidentMismatches: number;
  /** Fields nothing should fill, rightly left empty. */
  leftAlone: number;
}

export function judge(outcome: FieldOutcome): Judgement {
  const { expected, actual, confidence } = outcome;
  if (expected === null || expected === '') return { verdict: 'unlabelled', confident: false };
  if (expected === 'ambiguous') return { verdict: 'ambiguous', confident: false };

  const fills = actual !== 'unknown' && confidence >= CONFIDENCE.FILL_AND_FLAG;
  const confident = fills && confidence >= CONFIDENCE.AUTO_FILL;
  if (expected === 'unknown') return fills ? { verdict: 'mismatch', confident } : { verdict: 'left-alone', confident: false };
  if (!fills) return { verdict: 'unmapped', confident: false };
  return actual === expected ? { verdict: 'correct', confident } : { verdict: 'mismatch', confident };
}

const EMPTY: Tally = {
  fields: 0,
  labelled: 0,
  unlabelled: 0,
  ambiguous: 0,
  mappable: 0,
  correct: 0,
  correctConfident: 0,
  unmapped: 0,
  mismatched: 0,
  confidentMismatches: 0,
  leftAlone: 0,
};

export function tally(outcomes: readonly FieldOutcome[]): Tally {
  const total = { ...EMPTY };
  for (const outcome of outcomes) {
    const { verdict, confident } = judge(outcome);
    total.fields += 1;
    if (verdict === 'unlabelled') {
      total.unlabelled += 1;
      continue;
    }
    total.labelled += 1;
    if (verdict === 'ambiguous') {
      total.ambiguous += 1;
      continue;
    }
    if (outcome.expected !== 'unknown') total.mappable += 1;
    if (verdict === 'correct') {
      total.correct += 1;
      if (confident) total.correctConfident += 1;
    } else if (verdict === 'unmapped') {
      total.unmapped += 1;
    } else if (verdict === 'mismatch') {
      total.mismatched += 1;
      if (confident) total.confidentMismatches += 1;
    } else if (verdict === 'left-alone') {
      total.leftAlone += 1;
    }
  }
  return total;
}

export function combine(tallies: readonly Tally[]): Tally {
  const total = { ...EMPTY };
  for (const one of tallies) {
    for (const key of Object.keys(total) as Array<keyof Tally>) total[key] += one[key];
  }
  return total;
}

/** Correct as a share of fields whose answer is a key; null when there are none. */
export function accuracy(t: Tally): number | null {
  return t.mappable === 0 ? null : t.correct / t.mappable;
}
