/**
 * Approval tokens (§ Phase 7, §5).
 *
 *   "`REVIEW → ARMED` requires an explicit user gesture; `approvalToken` is a
 *    random 128-bit value with a **90-second TTL** and is single-use."
 *   "`ARMED → SUBMITTED` permits exactly **one** programmatic click on exactly
 *    the element recorded in the plan. Token is burned first."
 *
 * ## What a token actually is
 *
 * Not a permission slip — a *description of one specific act*. It names the
 * tab, the form, and the element, and it expires. That matters because the
 * threat is not someone forging a token; both ends are extension contexts. The
 * threat is a token outliving the thing the user looked at: they approve a
 * review of page A, the portal navigates, and a stale approval submits page B.
 * Binding the token to the fingerprint is what makes that impossible.
 *
 * The registry lives in the worker. The content script's guard holds a copy of
 * the token to compare against, but it is this side that decides a token is
 * spent — one authority, not two that can disagree.
 */

import { APPROVAL_TOKEN_BYTES, APPROVAL_TOKEN_TTL_MS } from '@/shared/types';

export interface ApprovalGrant {
  /** 128 bits, hex. */
  token: string;
  issuedAt: number;
  expiresAt: number;
  tabId: number;
  /** The form as it was when the user approved it. */
  formFingerprint: string;
  /** The one element this token permits activating. */
  targetSelector: string;
}

export type ApprovalRefusal =
  | 'no-grant'
  | 'wrong-token'
  | 'expired'
  | 'wrong-tab'
  | 'form-changed'
  | 'wrong-target';

export type ApprovalCheck =
  | { ok: true; grant: ApprovalGrant }
  | { ok: false; why: ApprovalRefusal };

/**
 * Mint a 128-bit token.
 *
 * `crypto.getRandomValues`, not `Math.random`. The value is not defending
 * against a network attacker, but a predictable "random" token is the kind of
 * detail that is correct until the day the code moves somewhere it matters.
 */
export function mintToken(bytes: number = APPROVAL_TOKEN_BYTES): string {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return [...buffer].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * The worker's record of what the user has approved.
 *
 * At most one grant per tab: approving a second form in the same tab replaces
 * the first, because the user cannot be looking at two review screens at once.
 */
export class ApprovalRegistry {
  #grants = new Map<number, ApprovalGrant>();

  /** Record a deliberate approval. Replaces any earlier grant for the tab. */
  issue(args: {
    tabId: number;
    formFingerprint: string;
    targetSelector: string;
    now?: number;
    token?: string;
  }): ApprovalGrant {
    const now = args.now ?? Date.now();
    const grant: ApprovalGrant = {
      token: args.token ?? mintToken(),
      issuedAt: now,
      expiresAt: now + APPROVAL_TOKEN_TTL_MS,
      tabId: args.tabId,
      formFingerprint: args.formFingerprint,
      targetSelector: args.targetSelector,
    };
    this.#grants.set(args.tabId, grant);
    return grant;
  }

  /**
   * Check a token without spending it.
   *
   * Every refusal is named rather than collapsed into `false`, because the
   * panel has to tell the user *why* their approval no longer counts. "That
   * took too long, please look again" and "the page changed underneath you"
   * are different sentences, and the second one is a warning.
   */
  check(
    args: { tabId: number; token: string; formFingerprint?: string; targetSelector?: string },
    now: number = Date.now(),
  ): ApprovalCheck {
    const grant = this.#grants.get(args.tabId);
    if (!grant) return { ok: false, why: 'no-grant' };
    if (grant.tabId !== args.tabId) return { ok: false, why: 'wrong-tab' };
    if (!constantTimeEquals(grant.token, args.token)) return { ok: false, why: 'wrong-token' };
    if (now >= grant.expiresAt) return { ok: false, why: 'expired' };
    if (args.formFingerprint !== undefined && args.formFingerprint !== grant.formFingerprint) {
      return { ok: false, why: 'form-changed' };
    }
    if (args.targetSelector !== undefined && args.targetSelector !== grant.targetSelector) {
      return { ok: false, why: 'wrong-target' };
    }
    return { ok: true, grant };
  }

  /**
   * Spend the token.
   *
   * **Burned before the submission, not after.** If the click throws, or the
   * page navigates mid-flight, or the worker is suspended between the two
   * lines, the token must already be gone — a token that survives a failed
   * submission is a token available for a second attempt nobody approved.
   */
  consume(
    args: { tabId: number; token: string; formFingerprint?: string; targetSelector?: string },
    now: number = Date.now(),
  ): ApprovalCheck {
    const result = this.check(args, now);
    // Burn on any decisive outcome for this tab's grant — a valid use, or a
    // rejection that means the grant is no longer meaningful. A wrong token
    // leaves the real one alone, so a bug elsewhere cannot cancel an approval.
    if (result.ok || result.why === 'expired' || result.why === 'form-changed' || result.why === 'wrong-target') {
      this.#grants.delete(args.tabId);
    }
    return result;
  }

  /** Drop a tab's grant — the user navigated, aborted, or closed the tab. */
  revoke(tabId: number): void {
    this.#grants.delete(tabId);
  }

  /** Is there a live approval for this tab right now? */
  active(tabId: number, now: number = Date.now()): ApprovalGrant | null {
    const grant = this.#grants.get(tabId);
    if (!grant) return null;
    if (now >= grant.expiresAt) {
      this.#grants.delete(tabId);
      return null;
    }
    return grant;
  }

  /** Milliseconds left on this tab's approval, or 0. */
  remainingMs(tabId: number, now: number = Date.now()): number {
    const grant = this.active(tabId, now);
    return grant ? Math.max(0, grant.expiresAt - now) : 0;
  }

  clear(): void {
    this.#grants.clear();
  }
}

/**
 * Compare without leaking length or position through timing.
 *
 * Almost certainly unnecessary here — the comparison happens inside our own
 * worker against a value we minted. It costs three lines, and the alternative
 * is a reader having to work out whether it is necessary.
 */
function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export const REFUSAL_TEXT: Readonly<Record<ApprovalRefusal, string>> = Object.freeze({
  'no-grant': 'That approval is no longer active. Review the form and approve again.',
  'wrong-token': 'That approval did not match. Review the form and approve again.',
  expired: 'Your approval timed out after 90 seconds. Check the form and approve again.',
  'wrong-tab': 'That approval was for a different tab.',
  'form-changed': 'The page changed after you approved it. Check the form again before submitting.',
  'wrong-target': 'The submit button changed after you approved. Check the form again.',
});
