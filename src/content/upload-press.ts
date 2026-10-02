/**
 * One document's approved upload — the page's half (§ document attachment).
 *
 * The worker has already checked the approval and burned the token; this arms
 * the guard with it and lets the guard press exactly the recorded element.
 * The guard owns the click (CLAUDE.md rule 1); nothing here clicks anything.
 *
 * One thing happens first. A button that posts the form posts *every* file box
 * in it, and the user approved one document. So when the press will submit
 * the form, the other file boxes in that form are emptied first — the postback
 * would empty them anyway. A button that does not post the form (an AJAX
 * "Upload") sends only its own file, and the others are left as they are.
 */

import { arm, isSubmitish, submitWithApproval, type ApprovalToken } from './submit-guard';

export function pressUpload(
  token: ApprovalToken,
  approvedBox: Element | null,
  doc: Document = document,
): boolean {
  const target = doc.querySelector(token.targetSelector);

  // Nothing is emptied for a press that cannot happen: an expired token or a
  // missing button would leave the user's other documents gone for nothing.
  if (target && token.expiresAt > Date.now()) {
    const form = target.closest('form');
    if (form && isSubmitish(target)) {
      for (const box of form.querySelectorAll<HTMLInputElement>('input[type="file"]')) {
        if (box !== approvedBox && (box.files?.length ?? 0) > 0) box.value = '';
      }
    }
  }

  arm(token);
  return submitWithApproval(token, doc);
}
