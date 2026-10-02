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
import { isDocumentKey, isFieldKey } from '@/matching/taxonomy';
import { harvestTab } from './harvest-service';
import { endRun } from './fill-service';
import { collectValues, forgetTabReview } from './review-service';
import { noteUploaded, uploadedKeys } from './upload-state';
import { uploadAllToWindows, type BatchItem } from './upload-window-service';
import type { FieldKey } from '@/matching/taxonomy';

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

/**
 * One document's upload: approved by a hold, then its Upload button pressed.
 *
 * Many portals put an "Upload" beside each file box that posts the whole form.
 * The guard blocks that like any submit — rightly, since the form carries what
 * we filled — so the only way through is the one the final submit takes: an
 * approval, spent before the click, naming exactly one element.
 *
 * ## What the panel can and cannot say
 *
 * It names the file box, nothing more. *Which* button that is comes from the
 * worker's own fresh harvest, and the harvest never records the final submit
 * as a document's Upload (`upload-slots.ts`), so no panel bug can aim an
 * upload approval at "Submit Application".
 *
 * ## One step, not two
 *
 * The final submit's approval is two calls, grant then submit, so the user
 * can watch a clock and change their mind before the application goes. Here
 * the user asked for "approve, then it presses" — the 1.5-second hold is the
 * deliberate gesture, and releasing early is the change of mind. Everything
 * else is identical: the registry issues a single-use token bound to the page
 * and the element, and it is burned before the click.
 *
 * The run is **not** ended, unlike after the final submit: the application is
 * still being filled, and the next document may be next.
 */
export async function uploadWithApproval(
  tabId: number,
  ref: string,
): Promise<Result<{ pressed: boolean; why?: string; reloading?: boolean }>> {
  const harvested = await harvestTab(tabId);
  if (!harvested.ok) return harvested;
  const harvest = harvested.data;

  const field = harvest.fields.find((f) => f.ref === ref && f.frameId === 0 && f.tag === 'file');
  const match = harvest.matches.find((m) => m.fieldRef === ref);
  const button = harvest.uploadButtons[ref];
  if (!field || !button || !match || !isFieldKey(match.key) || !isDocumentKey(match.key)) {
    return {
      ok: true,
      data: {
        pressed: false,
        why: 'That document’s Upload button is not on the page any more. Scan the page again.',
      },
    };
  }
  const key = match.key;

  const refuse = async (why: string) => {
    await appendAudit({
      site: harvest.url,
      formFingerprint: harvest.fingerprint,
      event: { t: 'upload.refused', key, why },
    }).catch(() => {});
    return { ok: true as const, data: { pressed: false, why } };
  };

  if (uploadedKeys(tabId).has(key)) {
    return refuse('It was already uploaded in this run.');
  }

  // A human-only step outstanding means P4 applies here as at the final submit.
  const blocker = harvest.blockers.find((b) => b.type === 'captcha' || b.type === 'otp');
  if (blocker) return refuse(`${blocker.reason} Complete it first, then approve.`);

  // Read back, not remembered: the box must hold the document right now.
  const held = await collectValues(tabId, [ref]);
  if (held.get(ref) !== 'file') {
    return refuse('There is no document in that box right now. Press “Fill this form” first.');
  }

  const grant = registry.issue({
    tabId,
    formFingerprint: harvest.fingerprint,
    targetSelector: button.selector,
  });
  await appendAudit({
    site: harvest.url,
    formFingerprint: harvest.fingerprint,
    event: { t: 'upload.approved', key, target: button.selector },
  });

  const check = registry.consume({
    tabId,
    token: grant.token,
    formFingerprint: harvest.fingerprint,
    targetSelector: button.selector,
  });
  if (!check.ok) return refuse(REFUSAL_TEXT[check.why]);

  let pressed: boolean;
  let reloading = false;
  try {
    const response = (await chrome.tabs.sendMessage(
      tabId,
      envelope({
        type: 'fill:press-upload',
        token: {
          value: check.grant.token,
          expiresAt: check.grant.expiresAt,
          targetSelector: check.grant.targetSelector,
        },
        ref,
      }),
      { frameId: 0 },
    )) as Result<{ pressed: boolean }> | undefined;
    pressed = response?.ok === true && response.data.pressed;
  } catch (error) {
    /*
     * Two silences, and they mean opposite things. "Receiving end does not
     * exist": nothing heard the message, so nothing was pressed. "Message port
     * closed": the page heard it and went away before answering — which is
     * exactly what a submit-type Upload does when it posts the form back.
     */
    const detail = error instanceof Error ? error.message : String(error);
    reloading = /message port closed/i.test(detail);
    pressed = reloading;
  }

  if (!pressed) return refuse('The page did not take the press. Nothing was uploaded.');

  noteUploaded(tabId, key);
  await appendAudit({
    site: harvest.url,
    formFingerprint: harvest.fingerprint,
    event: { t: 'upload.done', key },
  }).catch(() => {});
  return { ok: true, data: reloading ? { pressed: true, reloading: true } : { pressed: true } };
}

/**
 * Every upload window on the form, after one hold (§ document attachment).
 *
 * A Google Form attaches a document only by uploading it, into Google's own
 * window, to the form owner's Drive — there is no "filled but not sent" state
 * as a file box has. So, as with a portal's Upload button, it takes the
 * deliberate gesture: one hold approves this form's documents, and each
 * document still gets its own single-use token, bound to its own "Add file"
 * control and to this page, burned before its first press
 * (`upload-window-service.ts` → `uploadAllToWindows`).
 */
export async function uploadAllWithApproval(
  tabId: number,
  picks: Readonly<Record<string, FieldKey>>,
): Promise<Result<{ items: BatchItem[] }>> {
  return uploadAllToWindows(tabId, picks, (slot, key, harvest) => {
    const target = slot.selectors[0] ?? slot.ref;
    const grant = registry.issue({ tabId, formFingerprint: harvest.fingerprint, targetSelector: target });
    const check = registry.consume({
      tabId,
      token: grant.token,
      formFingerprint: harvest.fingerprint,
      targetSelector: target,
    });
    if (!check.ok) return null;
    void appendAudit({
      site: harvest.url,
      formFingerprint: harvest.fingerprint,
      event: { t: 'upload.approved', key, target },
    }).catch(() => {});
    return { value: check.grant.token, expiresAt: check.grant.expiresAt };
  });
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
