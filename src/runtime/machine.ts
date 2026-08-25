/**
 * Phase 6 — the RunState reducer (§5).
 *
 * Pure, no DOM, no `chrome.*`, no clock of its own. `now` is a parameter, so
 * the 90-second approval TTL and the "did this arm expire" question are
 * testable without waiting ninety seconds.
 *
 * Why a reducer at all, when a run *feels* linear: it isn't. A CAPTCHA hands
 * control back to the user mid-run; an ASP.NET postback wipes every value and
 * regenerates every id; the user may walk away and come back after the vault
 * has re-locked. Each of those is a transition someone has to have thought
 * about in advance, and the honest place to think about them is a table of
 * legal moves rather than a tangle of `if` statements inside the content
 * script.
 *
 * Two conventions carry a lot of weight here:
 *
 *  1. **An illegal event returns the state object unchanged, by identity.**
 *     Callers can assert `reduce(s, e) === s`. Fail-closed: an event nobody
 *     anticipated cannot advance the run.
 *  2. **Only `FILLING` may write to the page** (`mayWritePage`). That is what
 *     "on block, the extension stops touching the page" means mechanically,
 *     and it is enforced in one place rather than remembered in five.
 */

import {
  APPROVAL_TOKEN_TTL_MS,
  DRIFT_MUTATION_THRESHOLD,
  type BlockReason,
  type FieldDescriptor,
  type FieldRef,
  type FillPlan,
  type PlannedField,
  type ReviewDiff,
  type RunState,
  type SerializedError,
} from '@/shared/types';

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/** What kind of upheaval the page just went through. */
export type ChurnKind = 'navigation' | 'postback' | 'mutation';

export type RunEvent =
  /** The user asked us to look at this page. */
  | { t: 'DETECT' }
  | { t: 'FIELDS_FOUND'; fields: FieldDescriptor[] }
  | { t: 'NO_FORM' }
  | { t: 'PLAN_READY'; plan: FillPlan }
  | { t: 'UNMAPPED'; unmapped: FieldDescriptor[] }
  /** A high-sensitivity key needs the passphrase again (§Phase 6 Must). */
  | { t: 'REAUTH_REQUIRED' }
  | { t: 'UNLOCKED' }
  | { t: 'FILL_START' }
  | { t: 'FIELD_FILLED'; fieldRef: FieldRef; at: number }
  | { t: 'FIELD_FAILED'; fieldRef: FieldRef }
  /** A CAPTCHA, OTP, eSign or payment gate. We stop; the user acts. */
  | { t: 'BLOCKER_SEEN'; reason: BlockReason }
  /** The user pressed "I've completed this — continue". */
  | { t: 'USER_CONTINUE' }
  /** The MutationObserver reports the page has stopped changing. */
  | { t: 'DOM_SETTLED'; blockerGone: boolean }
  /** Deliberately inert while BLOCKED — see the rule in §5. */
  | { t: 'TIMER_TICK' }
  | { t: 'DOM_CHURN'; kind: ChurnKind; ratio?: number }
  | { t: 'REVERIFIED'; plan: FillPlan; needsRefill: FieldRef[]; diff: ReviewDiff }
  | { t: 'DRIFT'; lost: FieldRef[] }
  | { t: 'TEACH'; unmapped: FieldDescriptor[] }
  | { t: 'TAUGHT'; plan: FillPlan }
  | { t: 'REVIEW_READY'; diff: ReviewDiff }
  /** The explicit approval gesture (§Phase 7 raises it; §5 defines it). */
  | { t: 'APPROVE'; token: string }
  | { t: 'SUBMIT_DONE'; at: number }
  | { t: 'ABORT'; why: string }
  | { t: 'FAIL'; err: SerializedError };

export type RunEventTag = RunEvent['t'];

/** §5: "a random 128-bit value" — 16 bytes, hex-encoded. */
const TOKEN_SHAPE = /^[0-9a-f]{32}$/;

export function isWellFormedToken(value: string): boolean {
  return TOKEN_SHAPE.test(value);
}

// ---------------------------------------------------------------------------
// Predicates the rest of the extension asks before acting
// ---------------------------------------------------------------------------

export function initial(): RunState {
  return { t: 'IDLE' };
}

export function isTerminal(state: RunState): boolean {
  return state.t === 'SUBMITTED' || state.t === 'ABORTED' || state.t === 'ERROR';
}

/**
 * May the extension write into the page right now?
 *
 * Exactly one state says yes. Blocked runs, drifted runs, and runs waiting at
 * the review screen all touch nothing — which is the mechanical meaning of
 * "the extension stops touching the page" when a security control appears.
 */
export function mayWritePage(state: RunState): boolean {
  return state.t === 'FILLING';
}

/** May the guard be armed? Only from a review the user is looking at. */
export function mayArm(state: RunState): boolean {
  return state.t === 'REVIEW';
}

/** The plan attached to this state, when there is one. */
export function planOf(state: RunState): FillPlan | null {
  return 'plan' in state ? state.plan : null;
}

// ---------------------------------------------------------------------------
// The reducer
// ---------------------------------------------------------------------------

export function reduce(state: RunState, event: RunEvent, now: number = Date.now()): RunState {
  // Abort and failure are universal, but they cannot rewrite history: a run
  // that has been submitted stays submitted. There is no un-submitting, and an
  // audit log that claimed otherwise would be worse than none.
  if (event.t === 'ABORT') {
    return isTerminal(state) ? state : { t: 'ABORTED', why: event.why };
  }
  if (event.t === 'FAIL') {
    return isTerminal(state) ? state : { t: 'ERROR', err: event.err };
  }

  // An arm that has run out of time is not armed, whatever the stored tag
  // says. Checked on access rather than by a timer, for the same reason the
  // vault does it that way: an MV3 worker can be suspended mid-countdown.
  const current = expireArm(state, now);

  switch (current.t) {
    case 'IDLE':
      return event.t === 'DETECT' ? { t: 'DETECTING' } : current;

    case 'DETECTING':
      if (event.t === 'FIELDS_FOUND') return { t: 'PLANNING', fields: event.fields };
      if (event.t === 'NO_FORM') return { t: 'IDLE' };
      return current;

    case 'PLANNING':
      if (event.t === 'PLAN_READY') return { t: 'READY', plan: event.plan };
      if (event.t === 'UNMAPPED') return { t: 'NEEDS_TEACHING', unmapped: event.unmapped };
      return current;

    case 'NEEDS_TEACHING':
      if (event.t === 'TAUGHT') return { t: 'READY', plan: event.plan };
      return current;

    case 'READY':
      if (event.t === 'FILL_START') return { t: 'FILLING', plan: current.plan, cursor: 0 };
      if (event.t === 'REAUTH_REQUIRED') return { t: 'UNLOCKING', plan: current.plan };
      // A gate seen *before* the first write blocks just as hard as one seen
      // mid-run. Without this the run would fill the whole form and only then
      // notice the CAPTCHA — putting the user's data on a page it had already
      // decided it was not allowed to touch.
      if (event.t === 'BLOCKER_SEEN') return { t: 'BLOCKED', reason: event.reason, plan: current.plan };
      return current;

    case 'UNLOCKING':
      if (event.t === 'UNLOCKED') {
        return current.plan ? { t: 'READY', plan: current.plan } : { t: 'IDLE' };
      }
      return current;

    case 'FILLING':
      return fromFilling(current, event);

    case 'BLOCKED':
      return fromBlocked(current, event);

    case 'REVERIFYING':
      return fromReverifying(current, event);

    case 'DRIFTED':
      // The only way out is repair. Never a quiet skip: a field we silently
      // dropped is a field the user believes was filled.
      if (event.t === 'TEACH') return { t: 'NEEDS_TEACHING', unmapped: event.unmapped };
      return current;

    case 'REVIEW':
      return fromReview(current, event, now);

    case 'ARMED':
      return fromArmed(current, event);

    case 'SUBMITTED':
    case 'ABORTED':
    case 'ERROR':
      return current;
  }
}

// ---------------------------------------------------------------------------
// Per-state transitions
// ---------------------------------------------------------------------------

function fromFilling(state: Extract<RunState, { t: 'FILLING' }>, event: RunEvent): RunState {
  switch (event.t) {
    case 'FIELD_FILLED':
      return {
        t: 'FILLING',
        plan: markField(state.plan, event.fieldRef, { filledAt: event.at }),
        cursor: state.cursor + 1,
      };
    case 'FIELD_FAILED':
      return {
        t: 'FILLING',
        plan: markField(state.plan, event.fieldRef, { fillFailed: true }),
        cursor: state.cursor + 1,
      };
    case 'BLOCKER_SEEN':
      return { t: 'BLOCKED', reason: event.reason, plan: state.plan };
    case 'DOM_CHURN':
      return forcesReverify(event) ? { t: 'REVERIFYING', plan: state.plan } : state;
    case 'DRIFT':
      return { t: 'DRIFTED', plan: state.plan, lost: event.lost };
    case 'REVIEW_READY':
      return { t: 'REVIEW', plan: state.plan, diff: event.diff };
    default:
      return state;
  }
}

/**
 * §5: `BLOCKED → REVERIFYING` only on a user signal **or** a MutationObserver
 * settling event — never on a timer alone.
 *
 * `DOM_SETTLED` additionally carries whether the blocker is actually gone. A
 * CAPTCHA widget mutates constantly while the user works on it; treating every
 * settle as "done" would resume the run over the user's shoulder while they
 * are still typing.
 */
function fromBlocked(state: Extract<RunState, { t: 'BLOCKED' }>, event: RunEvent): RunState {
  switch (event.t) {
    case 'USER_CONTINUE':
      return { t: 'REVERIFYING', plan: state.plan };
    case 'DOM_SETTLED':
      return event.blockerGone ? { t: 'REVERIFYING', plan: state.plan } : state;
    case 'BLOCKER_SEEN':
      return event.reason === state.reason
        ? state
        : { t: 'BLOCKED', reason: event.reason, plan: state.plan };
    // TIMER_TICK and DOM_CHURN deliberately fall through to "no change".
    default:
      return state;
  }
}

function fromReverifying(
  state: Extract<RunState, { t: 'REVERIFYING' }>,
  event: RunEvent,
): RunState {
  switch (event.t) {
    case 'REVERIFIED':
      // Something was reset by the postback → go back to filling it. Nothing
      // was → the page is as we left it, so the user can review.
      return event.needsRefill.length > 0
        ? { t: 'FILLING', plan: event.plan, cursor: 0 }
        : { t: 'REVIEW', plan: event.plan, diff: event.diff };
    case 'DRIFT':
      return { t: 'DRIFTED', plan: state.plan, lost: event.lost };
    case 'BLOCKER_SEEN':
      return { t: 'BLOCKED', reason: event.reason, plan: state.plan };
    default:
      // Churn during re-verification changes nothing: we are already going to
      // walk every field. The caller restarts its pass; the state is correct.
      return state;
  }
}

function fromReview(
  state: Extract<RunState, { t: 'REVIEW' }>,
  event: RunEvent,
  now: number,
): RunState {
  switch (event.t) {
    case 'APPROVE':
      // A malformed token is refused rather than trusted. The reducer is the
      // last place that can tell the difference between a 128-bit random value
      // and something a bug handed us.
      if (!isWellFormedToken(event.token)) return state;
      return {
        t: 'ARMED',
        plan: state.plan,
        approvalToken: event.token,
        expiresAt: now + APPROVAL_TOKEN_TTL_MS,
      };
    case 'DOM_CHURN':
      return forcesReverify(event) ? { t: 'REVERIFYING', plan: state.plan } : state;
    case 'BLOCKER_SEEN':
      return { t: 'BLOCKED', reason: event.reason, plan: state.plan };
    case 'REVIEW_READY':
      return { t: 'REVIEW', plan: state.plan, diff: event.diff };
    default:
      return state;
  }
}

function fromArmed(state: Extract<RunState, { t: 'ARMED' }>, event: RunEvent): RunState {
  switch (event.t) {
    case 'SUBMIT_DONE':
      return { t: 'SUBMITTED', at: event.at };
    case 'DOM_CHURN':
      // The page changed *after* the user approved it. The approval described
      // a page that no longer exists, so it is discarded — re-verify, and let
      // the user approve what is actually there now.
      return forcesReverify(event) ? { t: 'REVERIFYING', plan: state.plan } : state;
    case 'BLOCKER_SEEN':
      return { t: 'BLOCKED', reason: event.reason, plan: state.plan };
    default:
      return state;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * §5: navigation and postback always force re-verification; a mutation does so
 * only once it has touched more than 20% of the tracked nodes. Small mutations
 * are just a page being a page.
 */
function forcesReverify(event: Extract<RunEvent, { t: 'DOM_CHURN' }>): boolean {
  if (event.kind !== 'mutation') return true;
  return (event.ratio ?? 0) > DRIFT_MUTATION_THRESHOLD;
}

function expireArm(state: RunState, now: number): RunState {
  if (state.t !== 'ARMED' || now < state.expiresAt) return state;
  // Time passed, so the page may have too. Re-verify rather than dropping the
  // user back onto a review screen that was accurate ninety seconds ago.
  return { t: 'REVERIFYING', plan: state.plan };
}

function markField(
  plan: FillPlan,
  ref: FieldRef,
  patch: Partial<Pick<PlannedField, 'filledAt' | 'fillFailed' | 'truncated'>>,
): FillPlan {
  return {
    ...plan,
    fields: plan.fields.map((field) => (field.fieldRef === ref ? { ...field, ...patch } : field)),
  };
}

/** Fold a sequence of events. Convenience for tests and for rehydration. */
export function applyAll(
  state: RunState,
  events: readonly RunEvent[],
  now: number = Date.now(),
): RunState {
  return events.reduce((acc, event) => reduce(acc, event, now), state);
}
