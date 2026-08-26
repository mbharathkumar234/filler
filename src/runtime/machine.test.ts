import { describe, expect, it } from 'vitest';

import {
  applyAll,
  initial,
  isTerminal,
  isWellFormedToken,
  mayArm,
  mayWritePage,
  planOf,
  reduce,
  type RunEvent,
} from './machine';
import {
  APPROVAL_TOKEN_TTL_MS,
  DRIFT_MUTATION_THRESHOLD,
  type FieldDescriptor,
  type FillPlan,
  type ReviewDiff,
  type RunState,
} from '@/shared/types';

/**
 * §5's transition rules, one test each.
 *
 * The plan says these "must be enforced by tests", so the rules are quoted in
 * the test names rather than paraphrased — if someone later relaxes one, the
 * failing test says which sentence of the plan they just broke.
 *
 * Everything here is pure data. No DOM, no chrome.*, no real clock: `now` is
 * passed in, which is the only reason the 90-second TTL is testable at all.
 */

const NOW = 1_700_000_000_000;

function plan(overrides: Partial<FillPlan> = {}): FillPlan {
  return {
    siteId: 'fixture-portal',
    profileVersion: null,
    formFingerprint: 'fp-abc',
    tabId: 7,
    fields: [
      { fieldRef: 'f1', key: 'identity.full_name', selectors: ['#a'], confidence: 0.95, source: 'rule' },
      { fieldRef: 'f2', key: 'contact.email', selectors: ['#b'], confidence: 0.9, source: 'rule' },
    ],
    documents: [],
    submit: { selectors: ['#btnSubmit'], label: 'Final Submit' },
    createdAt: NOW,
    ...overrides,
  };
}

function emptyDiff(): ReviewDiff {
  return {
    lowConfidence: [],
    truncated: [],
    fuzzySelect: [],
    fillFailed: [],
    requiredButEmpty: [],
  };
}

function descriptor(ref: string): FieldDescriptor {
  return {
    ref,
    selectors: [`#${ref}`],
    tag: 'input',
    labelText: 'Something',
    nearbyText: '',
    required: false,
    frameId: 0,
    visible: true,
    enabled: true,
  };
}

const TOKEN = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';

/** Walk the machine to a given state the way a real run would. */
function at(tag: RunState['t']): RunState {
  const events: RunEvent[] = [
    { t: 'DETECT' },
    { t: 'FIELDS_FOUND', fields: [descriptor('f1'), descriptor('f2')] },
    { t: 'PLAN_READY', plan: plan() },
  ];
  const ready = applyAll(initial(), events, NOW);
  switch (tag) {
    case 'READY':
      return ready;
    case 'FILLING':
      return reduce(ready, { t: 'FILL_START' }, NOW);
    case 'BLOCKED':
      return reduce(reduce(ready, { t: 'FILL_START' }, NOW), { t: 'BLOCKER_SEEN', reason: 'captcha' }, NOW);
    case 'REVERIFYING':
      return reduce(
        reduce(reduce(ready, { t: 'FILL_START' }, NOW), { t: 'BLOCKER_SEEN', reason: 'captcha' }, NOW),
        { t: 'USER_CONTINUE' },
        NOW,
      );
    case 'REVIEW':
      return reduce(
        reduce(ready, { t: 'FILL_START' }, NOW),
        { t: 'REVIEW_READY', diff: emptyDiff() },
        NOW,
      );
    case 'DRIFTED':
      return reduce(reduce(ready, { t: 'FILL_START' }, NOW), { t: 'DRIFT', lost: ['f2'] }, NOW);
    case 'ARMED':
      return reduce(at('REVIEW'), { t: 'APPROVE', token: TOKEN }, NOW);
    default:
      throw new Error(`no path built to ${tag}`);
  }
}

describe('the happy path', () => {
  it('walks IDLE → DETECTING → PLANNING → READY → FILLING → REVIEW', () => {
    const tags: RunState['t'][] = [];
    let state = initial();
    for (const event of [
      { t: 'DETECT' },
      { t: 'FIELDS_FOUND', fields: [descriptor('f1')] },
      { t: 'PLAN_READY', plan: plan() },
      { t: 'FILL_START' },
      { t: 'FIELD_FILLED', fieldRef: 'f1', at: NOW },
      { t: 'REVIEW_READY', diff: emptyDiff() },
    ] satisfies RunEvent[]) {
      state = reduce(state, event, NOW);
      tags.push(state.t);
    }

    expect(tags).toEqual([
      'DETECTING',
      'PLANNING',
      'READY',
      'FILLING',
      'FILLING',
      'REVIEW',
    ]);
  });

  it('records each filled field on the plan without mutating the old state', () => {
    const filling = at('FILLING');
    const before = planOf(filling)!.fields[0]!;
    const after = reduce(filling, { t: 'FIELD_FILLED', fieldRef: 'f1', at: NOW }, NOW);

    expect(planOf(after)!.fields[0]?.filledAt).toBe(NOW);
    // The previous state is untouched — this is what makes the persisted
    // history trustworthy rather than a view onto one mutable object.
    expect(before.filledAt).toBeUndefined();
  });

  it('a page with no form goes quietly back to IDLE', () => {
    const detecting = reduce(initial(), { t: 'DETECT' }, NOW);
    expect(reduce(detecting, { t: 'NO_FORM' }, NOW)).toEqual({ t: 'IDLE' });
  });
});

describe('illegal events are inert', () => {
  it('returns the very same object, so a caller can compare by identity', () => {
    const ready = at('READY');
    expect(reduce(ready, { t: 'SUBMIT_DONE', at: NOW }, NOW)).toBe(ready);
    expect(reduce(ready, { t: 'USER_CONTINUE' }, NOW)).toBe(ready);
    expect(reduce(ready, { t: 'REVERIFIED', plan: plan(), needsRefill: [], diff: emptyDiff() }, NOW)).toBe(
      ready,
    );
  });

  it('cannot reach SUBMITTED without passing through REVIEW and ARMED', () => {
    // Every state that is not ARMED refuses SUBMIT_DONE outright.
    for (const tag of ['READY', 'FILLING', 'BLOCKED', 'REVERIFYING', 'REVIEW', 'DRIFTED'] as const) {
      const state = at(tag);
      expect(reduce(state, { t: 'SUBMIT_DONE', at: NOW }, NOW).t).not.toBe('SUBMITTED');
    }
  });
});

describe('§5: FILLING → BLOCKED on a CAPTCHA, OTP or unknown security widget', () => {
  it.each(['captcha', 'otp', 'esign', 'payment', 'unknown_widget'] as const)(
    'blocks on %s',
    (reason) => {
      const blocked = reduce(at('FILLING'), { t: 'BLOCKER_SEEN', reason }, NOW);
      expect(blocked).toMatchObject({ t: 'BLOCKED', reason });
    },
  );

  it('stops touching the page the moment it blocks', () => {
    expect(mayWritePage(at('FILLING'))).toBe(true);
    for (const reason of ['captcha', 'otp', 'esign', 'payment', 'unknown_widget'] as const) {
      const blocked = reduce(at('FILLING'), { t: 'BLOCKER_SEEN', reason }, NOW);
      expect(mayWritePage(blocked)).toBe(false);
    }
  });

  it('blocks from READY too, before a single value is written', () => {
    // Found during the Phase 6 e2e: without this, a page whose CAPTCHA is
    // visible from the start gets the whole form filled and *then* blocks —
    // which is the opposite of what P4 promises.
    const ready = at('READY');
    const blocked = reduce(ready, { t: 'BLOCKER_SEEN', reason: 'captcha' }, NOW);

    expect(blocked).toMatchObject({ t: 'BLOCKED', reason: 'captcha' });
    expect(mayWritePage(blocked)).toBe(false);
  });

  it('keeps the plan, so the run can resume rather than restart', () => {
    const blocked = reduce(at('FILLING'), { t: 'BLOCKER_SEEN', reason: 'otp' }, NOW);
    expect(planOf(blocked)?.fields).toHaveLength(2);
  });

  it('a second, different blocker replaces the first', () => {
    const captcha = at('BLOCKED');
    const otp = reduce(captcha, { t: 'BLOCKER_SEEN', reason: 'otp' }, NOW);
    expect(otp).toMatchObject({ t: 'BLOCKED', reason: 'otp' });
    // The same blocker seen twice is not a transition.
    expect(reduce(captcha, { t: 'BLOCKER_SEEN', reason: 'captcha' }, NOW)).toBe(captcha);
  });
});

describe('§5: BLOCKED → REVERIFYING only on a user signal or a settling event — never on a timer', () => {
  it('resumes when the user says they have completed it', () => {
    expect(reduce(at('BLOCKED'), { t: 'USER_CONTINUE' }, NOW).t).toBe('REVERIFYING');
  });

  it('resumes on a settle only once the blocker is actually gone', () => {
    const blocked = at('BLOCKED');
    expect(reduce(blocked, { t: 'DOM_SETTLED', blockerGone: true }, NOW).t).toBe('REVERIFYING');
    // Still there: a CAPTCHA widget mutates constantly while it is being
    // solved, and resuming then would be filling over the user's hands.
    expect(reduce(blocked, { t: 'DOM_SETTLED', blockerGone: false }, NOW)).toBe(blocked);
  });

  it('never resumes on a timer, however many tick', () => {
    let state = at('BLOCKED');
    for (let i = 0; i < 1000; i += 1) {
      state = reduce(state, { t: 'TIMER_TICK' }, NOW + i * 1000);
    }
    expect(state.t).toBe('BLOCKED');
  });

  it('never resumes because the page merely changed', () => {
    const blocked = at('BLOCKED');
    for (const event of [
      { t: 'DOM_CHURN', kind: 'mutation', ratio: 1 },
      { t: 'DOM_CHURN', kind: 'postback' },
      { t: 'DOM_CHURN', kind: 'navigation' },
    ] satisfies RunEvent[]) {
      expect(reduce(blocked, event, NOW)).toBe(blocked);
    }
  });
});

describe('§5: navigation, postback, or >20% mutation forces REVERIFYING', () => {
  it('navigation and postback always force it', () => {
    expect(reduce(at('FILLING'), { t: 'DOM_CHURN', kind: 'navigation' }, NOW).t).toBe('REVERIFYING');
    expect(reduce(at('FILLING'), { t: 'DOM_CHURN', kind: 'postback' }, NOW).t).toBe('REVERIFYING');
  });

  it('a mutation forces it only above the 20% threshold', () => {
    const filling = at('FILLING');
    const under = reduce(filling, { t: 'DOM_CHURN', kind: 'mutation', ratio: 0.19 }, NOW);
    const over = reduce(filling, { t: 'DOM_CHURN', kind: 'mutation', ratio: 0.21 }, NOW);

    expect(under).toBe(filling);
    expect(over.t).toBe('REVERIFYING');
  });

  it('the threshold itself is the documented 20%, and is exclusive', () => {
    expect(DRIFT_MUTATION_THRESHOLD).toBe(0.2);
    const exactly = reduce(
      at('FILLING'),
      { t: 'DOM_CHURN', kind: 'mutation', ratio: DRIFT_MUTATION_THRESHOLD },
      NOW,
    );
    // "touching >20%" — exactly 20% is not more than 20%.
    expect(exactly.t).toBe('FILLING');
  });

  it('also forces it from the review screen — the user must review what is there now', () => {
    expect(reduce(at('REVIEW'), { t: 'DOM_CHURN', kind: 'postback' }, NOW).t).toBe('REVERIFYING');
  });
});

describe('§5: REVERIFYING refills what was reset, and escalates a lost selector to DRIFTED', () => {
  it('goes back to FILLING when a postback wiped something', () => {
    const next = reduce(
      at('REVERIFYING'),
      { t: 'REVERIFIED', plan: plan(), needsRefill: ['f1'], diff: emptyDiff() },
      NOW,
    );
    expect(next).toMatchObject({ t: 'FILLING', cursor: 0 });
  });

  it('goes to REVIEW when everything survived', () => {
    const next = reduce(
      at('REVERIFYING'),
      { t: 'REVERIFIED', plan: plan(), needsRefill: [], diff: emptyDiff() },
      NOW,
    );
    expect(next.t).toBe('REVIEW');
  });

  it('escalates to DRIFTED, naming what was lost', () => {
    const drifted = reduce(at('REVERIFYING'), { t: 'DRIFT', lost: ['f2'] }, NOW);
    expect(drifted).toMatchObject({ t: 'DRIFTED', lost: ['f2'] });
  });

  it('blocks if the re-verification pass walks into a security control', () => {
    expect(reduce(at('REVERIFYING'), { t: 'BLOCKER_SEEN', reason: 'otp' }, NOW).t).toBe('BLOCKED');
  });
});

describe('§5: DRIFTED → NEEDS_TEACHING — never a silent skip', () => {
  it('invites repair', () => {
    const teaching = reduce(at('DRIFTED'), { t: 'TEACH', unmapped: [descriptor('f2')] }, NOW);
    expect(teaching).toMatchObject({ t: 'NEEDS_TEACHING' });
  });

  it('refuses to walk to REVIEW while a field is lost', () => {
    // This is the whole point of DRIFTED. A run that quietly reviewed with a
    // missing field would tell the user everything was filled.
    const drifted = at('DRIFTED');
    expect(reduce(drifted, { t: 'REVIEW_READY', diff: emptyDiff() }, NOW)).toBe(drifted);
    expect(reduce(drifted, { t: 'FILL_START' }, NOW)).toBe(drifted);
  });
});

describe('§5: REVIEW → ARMED needs an explicit gesture, a 128-bit token, and 90 seconds', () => {
  it('arms on approval, stamping the TTL', () => {
    const armed = reduce(at('REVIEW'), { t: 'APPROVE', token: TOKEN }, NOW);
    expect(armed).toMatchObject({ t: 'ARMED', approvalToken: TOKEN });
    expect(armed.t === 'ARMED' && armed.expiresAt).toBe(NOW + APPROVAL_TOKEN_TTL_MS);
    expect(APPROVAL_TOKEN_TTL_MS).toBe(90_000);
  });

  it('refuses a token that is not 128 bits of hex', () => {
    const review = at('REVIEW');
    for (const bad of ['', 'short', TOKEN.slice(0, 31), `${TOKEN}0`, TOKEN.toUpperCase(), 'zzzz']) {
      expect(reduce(review, { t: 'APPROVE', token: bad }, NOW)).toBe(review);
    }
    expect(isWellFormedToken(TOKEN)).toBe(true);
  });

  it('only a review can arm — no other state accepts an approval', () => {
    for (const tag of ['READY', 'FILLING', 'BLOCKED', 'REVERIFYING', 'DRIFTED'] as const) {
      const state = at(tag);
      expect(mayArm(state)).toBe(false);
      expect(reduce(state, { t: 'APPROVE', token: TOKEN }, NOW)).toBe(state);
    }
    expect(mayArm(at('REVIEW'))).toBe(true);
  });
});

describe('§5: ARMED → SUBMITTED is exactly once', () => {
  it('submits, and then is terminal', () => {
    const submitted = reduce(at('ARMED'), { t: 'SUBMIT_DONE', at: NOW }, NOW);
    expect(submitted).toEqual({ t: 'SUBMITTED', at: NOW });
    expect(isTerminal(submitted)).toBe(true);
    // A second submission has nowhere to go.
    expect(reduce(submitted, { t: 'SUBMIT_DONE', at: NOW + 1 }, NOW)).toBe(submitted);
  });

  it('an expired arm cannot submit — it re-verifies instead', () => {
    const armed = at('ARMED');
    const late = NOW + APPROVAL_TOKEN_TTL_MS + 1;
    const next = reduce(armed, { t: 'SUBMIT_DONE', at: late }, late);

    expect(next.t).toBe('REVERIFYING');
  });

  it('the arm survives right up to the deadline', () => {
    const armed = at('ARMED');
    const justInTime = NOW + APPROVAL_TOKEN_TTL_MS - 1;
    expect(reduce(armed, { t: 'SUBMIT_DONE', at: justInTime }, justInTime).t).toBe('SUBMITTED');
  });

  it('discards the approval if the page changes after it was given', () => {
    // The user approved a page. A postback means that page is gone, so the
    // approval no longer describes anything they agreed to.
    const next = reduce(at('ARMED'), { t: 'DOM_CHURN', kind: 'postback' }, NOW);
    expect(next.t).toBe('REVERIFYING');
    expect(planOf(next)).not.toBeNull();
  });

  it('a blocker appearing after approval disarms it too', () => {
    expect(reduce(at('ARMED'), { t: 'BLOCKER_SEEN', reason: 'otp' }, NOW).t).toBe('BLOCKED');
  });
});

describe('§5: any state → ABORTED', () => {
  it.each(['READY', 'FILLING', 'BLOCKED', 'REVERIFYING', 'REVIEW', 'DRIFTED', 'ARMED'] as const)(
    'aborts from %s',
    (tag) => {
      const aborted = reduce(at(tag), { t: 'ABORT', why: 'user pressed Esc' }, NOW);
      expect(aborted).toEqual({ t: 'ABORTED', why: 'user pressed Esc' });
      expect(mayWritePage(aborted)).toBe(false);
    },
  );

  it('cannot un-submit a submitted run', () => {
    const submitted = reduce(at('ARMED'), { t: 'SUBMIT_DONE', at: NOW }, NOW);
    expect(reduce(submitted, { t: 'ABORT', why: 'too late' }, NOW)).toBe(submitted);
  });

  it('a failure anywhere becomes ERROR, carrying the reason', () => {
    const err = { name: 'TypeError', message: 'boom' };
    expect(reduce(at('FILLING'), { t: 'FAIL', err }, NOW)).toEqual({ t: 'ERROR', err });
  });
});

describe('the re-authentication gate', () => {
  it('holds the plan across an unlock, so the user does not start over', () => {
    const gated = reduce(at('READY'), { t: 'REAUTH_REQUIRED' }, NOW);
    expect(gated).toMatchObject({ t: 'UNLOCKING' });
    expect(planOf(gated)?.formFingerprint).toBe('fp-abc');

    const resumed = reduce(gated, { t: 'UNLOCKED' }, NOW);
    expect(resumed.t).toBe('READY');
    expect(planOf(resumed)?.formFingerprint).toBe('fp-abc');
  });

  it('cannot write to the page while waiting for the passphrase', () => {
    expect(mayWritePage(reduce(at('READY'), { t: 'REAUTH_REQUIRED' }, NOW))).toBe(false);
  });
});

describe('serialisability — this state is written to chrome.storage.session', () => {
  it('every reachable state survives a JSON round-trip unchanged', () => {
    for (const tag of ['READY', 'FILLING', 'BLOCKED', 'REVERIFYING', 'REVIEW', 'DRIFTED', 'ARMED'] as const) {
      const state = at(tag);
      expect(JSON.parse(JSON.stringify(state))).toEqual(state);
    }
  });

  it('carries field keys and selectors but never a value', () => {
    // The state is persisted; the values are not. Nothing in the run state
    // should ever be able to leak what was typed into the form.
    const serialised = JSON.stringify(at('REVIEW'));
    expect(serialised).toContain('identity.full_name');
    expect(serialised).not.toMatch(/value/i);
  });
});

// ---------------------------------------------------------------------------
// The fail-closed convention, tested exhaustively (found by mutation testing)
// ---------------------------------------------------------------------------

/**
 * Convention 1 in this module's header says:
 *
 *   "An illegal event returns the state object unchanged, by identity.
 *    Fail-closed: an event nobody anticipated cannot advance the run."
 *
 * That was asserted in prose and tested by example, which is not the same
 * thing. Mutation testing found it: flipping `event.t === 'UNMAPPED'` to
 * `!==` inside `case 'PLANNING'` — so that *every* unexpected event drove
 * PLANNING into NEEDS_TEACHING — broke nothing, because no test had ever sent
 * PLANNING an event it did not expect. The same held for NEEDS_TEACHING.
 *
 * A reducer's fail-closed rule is a property over the whole state × event
 * grid, so this tests the grid rather than a corner of it. Every cell is
 * either a transition somebody deliberately allowed, or identity.
 */

/** One well-formed instance of every event, so the grid can be walked. */
function everyEvent(): RunEvent[] {
  return [
    { t: 'DETECT' },
    { t: 'FIELDS_FOUND', fields: [descriptor('f1')] },
    { t: 'NO_FORM' },
    { t: 'PLAN_READY', plan: plan() },
    { t: 'UNMAPPED', unmapped: [descriptor('f9')] },
    { t: 'REAUTH_REQUIRED' },
    { t: 'UNLOCKED' },
    { t: 'FILL_START' },
    { t: 'FIELD_FILLED', fieldRef: 'f1', at: NOW },
    { t: 'FIELD_FAILED', fieldRef: 'f1' },
    { t: 'BLOCKER_SEEN', reason: 'captcha' },
    { t: 'USER_CONTINUE' },
    { t: 'DOM_SETTLED', blockerGone: true },
    { t: 'TIMER_TICK' },
    { t: 'DOM_CHURN', kind: 'mutation', ratio: DRIFT_MUTATION_THRESHOLD + 0.1 },
    { t: 'REVERIFIED', plan: plan(), needsRefill: [], diff: emptyDiff() },
    { t: 'DRIFT', lost: ['f2'] },
    { t: 'TEACH', unmapped: [descriptor('f9')] },
    { t: 'TAUGHT', plan: plan() },
    { t: 'REVIEW_READY', diff: emptyDiff() },
    { t: 'APPROVE', token: TOKEN },
    { t: 'SUBMIT_DONE', at: NOW },
    { t: 'ABORT', why: 'user closed the panel' },
    { t: 'FAIL', err: { name: 'Error', message: 'boom' } },
  ];
}

const REACHABLE: RunState['t'][] = [
  'READY',
  'FILLING',
  'BLOCKED',
  'REVERIFYING',
  'REVIEW',
  'DRIFTED',
  'ARMED',
];

describe('fail-closed: the whole state × event grid', () => {
  it('either transitions deliberately or returns the very same object', () => {
    // Not `toEqual` — *identity*. A reducer that rebuilds an identical state
    // for an unhandled event still tells every caller "something happened",
    // and `reduce(s, e) === s` is the check the rest of the runtime relies on.
    const offenders: string[] = [];

    for (const tag of REACHABLE) {
      for (const event of everyEvent()) {
        const before = at(tag);
        const after = reduce(before, event, NOW);
        if (after !== before && after.t === before.t && after === before) continue;
        // A same-tag result that is a *different object* is the suspicious
        // case: either a real in-place-style update (FIELD_FILLED on FILLING)
        // or an accident. Record it for the snapshot below rather than judging
        // it here.
        if (after !== before && after.t === before.t) {
          offenders.push(`${tag} + ${event.t} -> new object, same tag`);
        }
      }
    }

    // These are the legitimate same-tag transitions. Anything else appearing
    // here means a state started rebuilding itself for events it ignores.
    expect(offenders.sort()).toMatchSnapshot();
  });

  it('records the full grid, so a changed transition shows up in review', () => {
    const grid: string[] = [];
    for (const tag of REACHABLE) {
      for (const event of everyEvent()) {
        const before = at(tag);
        const after = reduce(before, event, NOW);
        grid.push(`${tag} + ${event.t} -> ${after === before ? '(unchanged)' : after.t}`);
      }
    }
    expect(grid).toMatchSnapshot();
  });

  it('never leaves a state on an event that state does not name', () => {
    // The sharpest form: for each state, the set of events that change its tag
    // must be exactly the set the reducer's own case block handles.
    const escapes: string[] = [];
    for (const tag of REACHABLE) {
      for (const event of everyEvent()) {
        const before = at(tag);
        const after = reduce(before, event, NOW);
        if (after.t !== before.t) escapes.push(`${tag} --${event.t}--> ${after.t}`);
      }
    }
    expect(escapes.sort()).toMatchSnapshot();
  });
});

describe('states that were never sent an unexpected event', () => {
  // The two the mutation tester found by name.
  it('PLANNING ignores everything except PLAN_READY and UNMAPPED', () => {
    const planning = reduce(reduce(initial(), { t: 'DETECT' }, NOW), {
      t: 'FIELDS_FOUND',
      fields: [descriptor('f1')],
    }, NOW);
    expect(planning.t).toBe('PLANNING');

    for (const event of everyEvent()) {
      if (event.t === 'PLAN_READY' || event.t === 'UNMAPPED') continue;
      if (event.t === 'ABORT' || event.t === 'FAIL') continue; // Handled globally.
      expect(reduce(planning, event, NOW), event.t).toBe(planning);
    }
  });

  it('NEEDS_TEACHING ignores everything except TAUGHT', () => {
    const needs = reduce(
      reduce(reduce(initial(), { t: 'DETECT' }, NOW), { t: 'FIELDS_FOUND', fields: [descriptor('f1')] }, NOW),
      { t: 'UNMAPPED', unmapped: [descriptor('f1')] },
      NOW,
    );
    expect(needs.t).toBe('NEEDS_TEACHING');

    for (const event of everyEvent()) {
      if (event.t === 'TAUGHT') continue;
      if (event.t === 'ABORT' || event.t === 'FAIL') continue;
      expect(reduce(needs, event, NOW), event.t).toBe(needs);
    }
  });
});
