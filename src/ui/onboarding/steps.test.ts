import { describe, expect, it } from 'vitest';

import { CORE_KEYS, CORE_THRESHOLD, currentStep, shouldShowChecklist, stepsFor, type SetupFacts } from './steps';

function facts(overrides: Partial<SetupFacts> = {}): SetupFacts {
  return {
    vaultReady: true,
    filledCoreKeys: [],
    usableDocuments: 0,
    unusableDocuments: 0,
    hasReviewedFill: false,
    ...overrides,
  };
}

describe('setup progress is read from the vault, not from clicks', () => {
  it('shows nothing done for a fresh, locked install', () => {
    const steps = stepsFor(facts({ vaultReady: false }));
    expect(steps.every((s) => !s.done)).toBe(true);
  });

  it('counts a user who set everything up before this screen existed as done', () => {
    // The property that matters. Somebody who has been using this for months
    // must not be shown a checklist telling them to start.
    const steps = stepsFor(
      facts({
        filledCoreKeys: [...CORE_KEYS],
        usableDocuments: 2,
        hasReviewedFill: true,
      }),
    );
    expect(steps.every((s) => s.done)).toBe(true);
    expect(shouldShowChecklist(steps, false)).toBe(false);
  });

  it('does not call the profile done on one detail', () => {
    const steps = stepsFor(facts({ filledCoreKeys: ['identity.full_name'] }));
    expect(steps.find((s) => s.id === 'profile')!.done).toBe(false);
  });

  it('calls the profile done at the threshold, not at every key', () => {
    // Requiring all of them would leave people stuck on a step they have no
    // reason to finish — not everyone has a middle name or a passport.
    const enough = CORE_KEYS.slice(0, CORE_THRESHOLD);
    expect(stepsFor(facts({ filledCoreKeys: enough })).find((s) => s.id === 'profile')!.done).toBe(true);
  });

  it('ignores keys that are filled but not core', () => {
    const steps = stepsFor(facts({ filledCoreKeys: ['bank.ifsc', 'education[].percentage', 'family.mother_name'] }));
    const profile = steps.find((s) => s.id === 'profile')!;
    expect(profile.done).toBe(false);
    expect(profile.progress).toEqual({ at: 0, of: CORE_KEYS.length });
  });

  it('does not count a document that failed its quality checks', () => {
    // The whole point of the check. A blurry photo stored is not a photo ready.
    const steps = stepsFor(facts({ usableDocuments: 0, unusableDocuments: 3 }));
    expect(steps.find((s) => s.id === 'documents')!.done).toBe(false);
  });
});

describe('the checklist knows when to leave', () => {
  it('stays while anything is unfinished', () => {
    expect(shouldShowChecklist(stepsFor(facts()), false)).toBe(true);
  });

  it('goes once everything is done, without being dismissed', () => {
    const steps = stepsFor(facts({ filledCoreKeys: [...CORE_KEYS], usableDocuments: 1, hasReviewedFill: true }));
    expect(shouldShowChecklist(steps, false)).toBe(false);
  });

  it('goes when dismissed, even with work outstanding', () => {
    expect(shouldShowChecklist(stepsFor(facts()), true)).toBe(false);
  });

  it('points at the first unfinished step', () => {
    const steps = stepsFor(facts({ vaultReady: true, filledCoreKeys: [...CORE_KEYS] }));
    expect(currentStep(steps)!.id).toBe('documents');
  });

  it('points nowhere when there is nothing left', () => {
    const steps = stepsFor(facts({ filledCoreKeys: [...CORE_KEYS], usableDocuments: 1, hasReviewedFill: true }));
    expect(currentStep(steps)).toBeUndefined();
  });
});

describe('the steps themselves', () => {
  it('are the four the plan names, in the order it names them', () => {
    expect(stepsFor(facts()).map((s) => s.id)).toEqual(['vault', 'profile', 'documents', 'first-fill']);
  });

  it('describe what the user gets, and say it without jargon', () => {
    for (const step of stepsFor(facts())) {
      expect(step.detail).not.toMatch(/vault:|taxonomy|selector|fingerprint|reducer/i);
      expect(step.title.length).toBeGreaterThan(4);
    }
  });

  it('asks only for details a person can answer from memory', () => {
    // The first-run list must not include anything requiring a document lookup
    // — that is what stalls people halfway through onboarding.
    expect(CORE_KEYS.some((k) => k.startsWith('id.') || k.startsWith('bank.'))).toBe(false);
  });
});
