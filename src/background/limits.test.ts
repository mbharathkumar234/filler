import { beforeEach, describe, expect, it } from 'vitest';

import {
  activeRunCount,
  beginRun,
  endRunLimit,
  MAX_RUNS_PER_HOUR,
  mayStartRun,
  RUN_LEASE_MS,
  RUN_WINDOW_MS,
  runsInWindow,
  __resetLimitsForTests,
} from './limits';

/**
 * P1 and P6, enforced.
 *
 * These limits are not abuse prevention — the user is the only person here.
 * They exist so the product cannot quietly become the unattended bulk-submitter
 * the plan forbids. A caps-off build with a scripted driver would satisfy every
 * other test in this repository while being exactly that.
 */

const NOW = 1_700_000_000_000;

beforeEach(() => {
  __resetLimitsForTests();
});

describe('P1: one active run per tab', () => {
  it('allows the first run', () => {
    expect(mayStartRun(7, NOW).allowed).toBe(true);
  });

  it('refuses a second run in the same tab', () => {
    beginRun(7, NOW);
    const decision = mayStartRun(7, NOW + 1_000);

    expect(decision.allowed).toBe(false);
    expect(decision.why).toBe('run-in-progress');
    expect(decision.message).toMatch(/already running/i);
  });

  it('allows a run in a different tab', () => {
    beginRun(7, NOW);
    expect(mayStartRun(9, NOW).allowed).toBe(true);
  });

  it('allows the tab again once the run ends', () => {
    beginRun(7, NOW);
    endRunLimit(7);
    expect(mayStartRun(7, NOW + 1_000).allowed).toBe(true);
  });

  it('releases a run whose worker was suspended mid-flight', () => {
    // Otherwise one interrupted run locks its tab out for good, which punishes
    // the user for the platform's behaviour.
    beginRun(7, NOW);
    expect(mayStartRun(7, NOW + RUN_LEASE_MS - 1).allowed).toBe(false);
    expect(mayStartRun(7, NOW + RUN_LEASE_MS + 1).allowed).toBe(true);
  });

  it('ending a run that never started is harmless', () => {
    expect(() => endRunLimit(999)).not.toThrow();
  });
});

describe('P6: an hourly cap a person never reaches', () => {
  function fillTheHour(from = NOW): void {
    for (let i = 0; i < MAX_RUNS_PER_HOUR; i += 1) {
      const tab = 100 + i;
      expect(mayStartRun(tab, from + i).allowed).toBe(true);
      beginRun(tab, from + i);
      endRunLimit(tab);
    }
  }

  it('is set where a script hits it and a human does not', () => {
    // Twenty forms in an hour is more than anybody fills by hand in a day. To
    // a loop it is a rounding error.
    expect(MAX_RUNS_PER_HOUR).toBe(20);
    expect(RUN_WINDOW_MS).toBe(60 * 60 * 1000);
  });

  it('admits exactly the cap, then stops', () => {
    fillTheHour();

    const decision = mayStartRun(999, NOW + 1_000);
    expect(decision.allowed).toBe(false);
    expect(decision.why).toBe('hourly-cap');
  });

  it('says why in words about the product, not about a quota', () => {
    fillTheHour();
    const decision = mayStartRun(999, NOW + 1_000);

    // The refusal is a statement of what this software is, because that is the
    // actual reason — not a rate limit someone should try to tune around.
    expect(decision.message).toMatch(/not a bulk submission tool/i);
  });

  it('tells the user when it will admit another', () => {
    fillTheHour();
    const decision = mayStartRun(999, NOW + 1_000);

    expect(decision.retryAt).toBeGreaterThan(NOW);
    expect(decision.retryAt).toBeLessThanOrEqual(NOW + RUN_WINDOW_MS);
  });

  it('forgets runs once they fall out of the window', () => {
    fillTheHour();
    expect(mayStartRun(999, NOW + 1_000).allowed).toBe(false);

    expect(mayStartRun(999, NOW + RUN_WINDOW_MS + 1).allowed).toBe(true);
  });

  it('counts a run once, whether or not it was released', () => {
    beginRun(7, NOW);
    endRunLimit(7);
    beginRun(8, NOW + 1);

    expect(runsInWindow(NOW + 2)).toBe(2);
  });

  it('a tab already running is refused for that reason, not the cap', () => {
    // Ordering matters for the message: "wait for the run to finish" is
    // actionable, "you have hit an hourly cap" is not.
    beginRun(7, NOW);
    expect(mayStartRun(7, NOW).why).toBe('run-in-progress');
  });
});

describe('bookkeeping', () => {
  it('reports how many runs are live', () => {
    beginRun(7, NOW);
    beginRun(9, NOW);
    expect(activeRunCount(NOW)).toBe(2);

    endRunLimit(7);
    expect(activeRunCount(NOW)).toBe(1);
  });

  it('drops expired leases from the count', () => {
    beginRun(7, NOW);
    expect(activeRunCount(NOW + RUN_LEASE_MS + 1)).toBe(0);
  });
});
