import { describe, expect, it } from 'vitest';

import { extendSplit, splitIsHonest, type SplitEntry } from './split';

/**
 * Tune and held-out (U0.M4, `MASTER_PROMPT.md`).
 *
 * A snapshot's side is decided once, when it first joins the corpus, and never
 * again. Held-out snapshots are only ever measured, never used to choose a rule,
 * synonym or threshold — so a form that later proves hard cannot quietly move
 * to the side where it may be tuned against.
 */

const names = (category: string, count: number) => Array.from({ length: count }, (_, i) => `${category}/form-${i + 1}`);

describe('which side a snapshot joins', () => {
  it('keeps each category near sixty to forty', () => {
    const split = extendSplit([], names('scholarships', 10));
    const tune = split.filter(([, side]) => side === 'tune').length;
    expect(tune).toBe(6);
    expect(split).toHaveLength(10);
  });

  it('balances each category on its own', () => {
    const split = extendSplit([], [...names('jobs', 5), ...names('travel', 5)]);
    for (const category of ['jobs', 'travel']) {
      const mine = split.filter(([name]) => name.startsWith(`${category}/`));
      expect(mine.filter(([, side]) => side === 'tune')).toHaveLength(3);
    }
  });

  it('never moves a snapshot already placed, however many join after it', () => {
    const first = extendSplit([], names('entrance', 4));
    const later = extendSplit(first, names('entrance', 12));
    expect(later.slice(0, first.length)).toEqual(first);
    expect(later).toHaveLength(12);
  });

  it('places new snapshots in an order nobody chooses', () => {
    const forwards = extendSplit([], names('banking', 8));
    const backwards = extendSplit([], names('banking', 8).reverse());
    expect(backwards).toEqual(forwards);
  });
});

describe('a split nobody has moved by hand', () => {
  it('replays to the same sides', () => {
    expect(splitIsHonest(extendSplit([], [...names('jobs', 7), ...names('legacy', 5)]))).toBe(true);
  });

  it('shows a snapshot moved from one side to the other', () => {
    const split = extendSplit([], names('jobs', 7));
    const moved: SplitEntry[] = split.map(([name, side], index) => (index === 3 ? [name, side === 'tune' ? 'held-out' : 'tune'] : [name, side]));
    expect(splitIsHonest(moved)).toBe(false);
  });
});
