/**
 * The re-authentication gate (§ Phase 6 Must).
 *
 *   "filling any `sensitivity: 'high'` key (Aadhaar, PAN, bank account) after
 *    an idle period requires passphrase re-entry."
 *
 * ## What this defends against
 *
 * The unattended-desk case, and only that. The vault is unlocked, the laptop
 * is open, the user has walked away, and someone else presses "Fill this
 * form" on a page of their choosing. Auto-lock eventually catches this; the
 * gate catches the fifteen minutes before auto-lock, for the handful of keys
 * where fifteen minutes is too long — the ones that are identity documents
 * rather than a postcode.
 *
 * ## Why the window is shorter than auto-lock
 *
 * If the gate's idle window were longer than the vault's, the vault would
 * always lock first and this code would never run. `reauth.test.ts` asserts
 * the ordering, because that is the kind of constant someone tunes upward one
 * afternoon without noticing they have deleted a control.
 *
 * Pure: no clock, no vault, no `chrome.*`. The caller supplies the times, and
 * the vault's own constant is compared against this one in the test rather
 * than imported here — importing `vault/session` would drag WebCrypto and idb
 * into every bundle that wants to ask a scheduling question.
 */

import { sensitivityOf, type FieldKey } from '@/matching/taxonomy';

/**
 * How long a passphrase entry vouches for a high-sensitivity fill.
 *
 * Three minutes: long enough that filling two forms in a sitting does not
 * become a passphrase-typing exercise, short enough that it is meaningfully
 * shorter than the fifteen-minute auto-lock it sits inside.
 */
export const REAUTH_IDLE_MS = 3 * 60 * 1000;

export interface ReauthDecision {
  required: boolean;
  /** The high-sensitivity keys that triggered it. Names only, never values. */
  keys: FieldKey[];
  /** How long since the last passphrase entry. */
  idleMs: number;
}

/**
 * Does this fill need the passphrase again?
 *
 * `lastAuthAt` is the last time the user actually typed their passphrase — not
 * the last time they clicked something. The vault's `touch()` defers auto-lock
 * on activity, which is right for auto-lock and wrong here: activity is not
 * evidence of *identity*, and treating it as such would mean a stranger at the
 * keyboard keeps their own gate open by using the extension.
 */
export function reauthCheck(
  keys: readonly FieldKey[],
  lastAuthAt: number | null,
  now: number,
): ReauthDecision {
  const sensitive = [...new Set(keys.filter((key) => sensitivityOf(key) === 'high'))];

  if (sensitive.length === 0) {
    return { required: false, keys: [], idleMs: 0 };
  }

  // Never authenticated in this session: fail closed.
  if (lastAuthAt === null) {
    return { required: true, keys: sensitive, idleMs: Number.POSITIVE_INFINITY };
  }

  const idleMs = now - lastAuthAt;
  return { required: idleMs >= REAUTH_IDLE_MS, keys: sensitive, idleMs };
}

/**
 * The sentence the user sees.
 *
 * Names the keys, because "confirm your passphrase" with no reason attached is
 * how users learn to type their passphrase whenever asked.
 */
export function describeReauth(keys: readonly FieldKey[]): string {
  const listed = keys.map(readableKey);
  const subject =
    listed.length === 1
      ? listed[0]
      : `${listed.slice(0, -1).join(', ')} and ${listed.at(-1) ?? ''}`;
  return `Enter your passphrase to fill ${subject}.`;
}

function readableKey(key: FieldKey): string {
  const leaf = key.split('.').at(-1) ?? key;
  return leaf.replace(/_/g, ' ');
}
