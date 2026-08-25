/**
 * Approval and submission (§ Phase 7).
 *
 * The whole product narrows to this file. Everything else is convenience;
 * this is where a form is actually sent, and it is the only place in the
 * extension that can cause that to happen.
 *
 * ## The shape of an approval
 *
 * Two steps, deliberately. `grant` records that the user performed the
 * deliberate gesture and starts the 90-second clock. `submit` spends it. They
 * are separate so the panel can show the clock, so an approval can lapse
 * without anything being sent, and so the user can change their mind — a
 * single call that approved *and* submitted would make "approved" and "sent"
 * the same instant, with nothing in between to interrupt.
 *
 * ## Where the token lives
 *
 * In the worker. The panel never receives it, so a bug in React cannot leak
 * one and a compromised panel cannot replay one. The content script is handed
 * the token only as the argument of the single submission it is asked to make.
 *
 * ## Refusals are not errors
 *
 * "Your approval expired" and "the page changed after you approved" are
 * outcomes the user must read, not exceptions to swallow. Each comes back as a
 * sentence, and each is written to the audit log.
 */

import type { Result } from '@/shared/messages';
import { envelope } from '@/shared/messages';
import { ApprovalRegistry, REFUSAL_TEXT } from '@/runtime/approval';
import { appendAudit } from '@/runtime/audit';
import { harvestTab } from './harvest-service';
import { endRun } from './fill-service';
import { forgetTabReview } from './review-service';

const registry = new ApprovalRegistry();

/** What the panel is told when it asks for a grant. Never the token. */
export interface GrantResult {
  expiresAt: number;
  target: string;
}

/**
 * Record the user's deliberate approval.
 *
 * Re-harvests first, and that is not belt-and-braces: the fingerprint captured
 * here is what a later submission is checked against. Taking it from a stale
 * plan would bind the approval to a page the user is no longer looking at,
 * which defeats the binding entirely.
 *
 * Refuses outright while a human-only step is outstanding. A CAPTCHA that has
 * not been solved means the submission would fail anyway — but more to the
 * point, approving *through* a blocker is the user telling us to do something
 * P4 says we do not do.
 */
export async function grantApproval(tabId: number): Promise<Result<GrantResult>> {
  const harvested = await harvestTab(tabId);
  if (!harvested.ok) return harvested;
  const harvest = harvested.data;

  const submit = harvest.frames.find((frame) => frame.frameId === 0)?.submit ?? null;
  if (!submit) {
    return {
      ok: false,
      error: 'No submit button was found on this page, so there is nothing to approve.',
      code: 'NO_SUBMIT',
    };
  }

  const blocker = harvest.blockers.find((b) => b.type === 'captcha' || b.type === 'otp');
  if (blocker) {
    return {
      ok: false,
      error: `${blocker.reason} Complete it first, then approve.`,
      code: 'BLOCKED',
    };
  }

  const grant = registry.issue({
    tabId,
    formFingerprint: harvest.fingerprint,
    targetSelector: submit.selector,
  });

  await appendAudit({
    site: harvest.url,
    formFingerprint: harvest.fingerprint,
    event: { t: 'submit.approved', target: submit.selector },
  });

  return { ok: true, data: { expiresAt: grant.expiresAt, target: submit.label } };
}

/**
 * Spend the approval and submit.
 *
 * The order matters and is the plan's: re-check the page, burn the token,
 * *then* ask the content script to click. Burning first means a click that
 * throws, a page that navigates mid-flight, or a worker suspended between the
 * two lines all leave nothing reusable behind. A token that survives a failed
 * submission is a token available for a second attempt nobody approved.
 */
export async function submitWithApproval(tabId: number): Promise<Result<{ submitted: boolean; why?: string }>> {
  const grant = registry.active(tabId);
  if (!grant) {
    return { ok: true, data: { submitted: false, why: REFUSAL_TEXT['no-grant'] } };
  }

  // What does the page look like *now*, not when they pressed the button?
  const harvested = await harvestTab(tabId);
  if (!harvested.ok) return harvested;
  const harvest = harvested.data;
  const submit = harvest.frames.find((frame) => frame.frameId === 0)?.submit ?? null;

  const check = registry.consume({
    tabId,
    token: grant.token,
    formFingerprint: harvest.fingerprint,
    ...(submit ? { targetSelector: submit.selector } : {}),
  });

  if (!check.ok) {
    const why = REFUSAL_TEXT[check.why];
    await appendAudit({
      site: harvest.url,
      formFingerprint: harvest.fingerprint,
      event: { t: 'submit.refused', why: check.why },
    });
    return { ok: true, data: { submitted: false, why } };
  }

  const response = (await chrome.tabs.sendMessage(
    tabId,
    envelope({
      type: 'fill:submit',
      token: {
        value: check.grant.token,
        expiresAt: check.grant.expiresAt,
        targetSelector: check.grant.targetSelector,
      },
    }),
    { frameId: 0 },
  )) as Result<{ submitted: boolean }> | undefined;

  const submitted = response?.ok === true && response.data.submitted;

  await appendAudit({
    site: harvest.url,
    formFingerprint: harvest.fingerprint,
    event: submitted ? { t: 'submit.done' } : { t: 'submit.refused', why: 'the page did not submit' },
  });

  // The run is over either way: the token is spent, so a retry needs a fresh
  // approval. Leaving the run authorised would let the page refill itself
  // after a submission the user has already signed off.
  endRun(tabId);
  forgetTabReview(tabId);

  return {
    ok: true,
    data: submitted
      ? { submitted: true }
      : { submitted: false, why: 'The page did not accept the submission. Nothing was sent.' },
  };
}

export function revokeApproval(tabId: number): void {
  registry.revoke(tabId);
}

export function approvalStatus(tabId: number): { active: boolean; remainingMs: number } {
  return { active: registry.active(tabId) !== null, remainingMs: registry.remainingMs(tabId) };
}

/** Test seam. */
export function __resetApprovalsForTests(): void {
  registry.clear();
}
