/**
 * The page's half of the review screen (§ Phase 7).
 *
 * Three jobs, all of them small and all of them read-mostly:
 *
 *  - **Collect.** Read back what is actually in each field, so the review
 *    shows the page's truth rather than our intentions. A portal that
 *    upper-cased a PAN or silently dropped a character must be visible here,
 *    because that mismatch is precisely what a review is for.
 *  - **Focus.** Click a row in the panel, scroll to the field and outline it.
 *    A review screen that cannot show you *which* box it is talking about
 *    makes the user do the correlation by hand, forty times.
 *  - **Edit.** Write a correction back through the same filler the run uses,
 *    so a hand-typed value goes in exactly the way a filled one did — native
 *    setter, real events, the lot. A correction that a framework ignores is
 *    worse than no correction, because the user watched it appear.
 *
 * The highlight is drawn with an overlay element rather than by restyling the
 * field. Setting a style on the page's own input would leave a fingerprint the
 * harvester promises not to leave, and could trip a portal's own validation.
 */

import { fillField } from './fill-field';
import { readValue } from './reverify';

const HIGHLIGHT_ID = 'autofill-assistant-highlight';
const HIGHLIGHT_MS = 2200;

/** Read back the live value of each ref. */
export function collectValues(
  refs: readonly string[],
  resolve: (ref: string) => Element | null,
): Record<string, string> {
  const values: Record<string, string> = {};
  for (const ref of refs) {
    const el = resolve(ref);
    values[ref] = el ? readValue(el) : '';
  }
  return values;
}

/**
 * Scroll a field into view and mark it, without touching the field itself.
 *
 * The marker is positioned over the element and removed on a timer. It lives
 * in its own container so it cannot be confused with the page's own chrome,
 * and it is `pointer-events: none` so it never steals a click from the user
 * who is about to correct the value underneath it.
 */
export function focusField(el: Element, doc: Document = document): void {
  // Guarded because this must never be the thing that throws: scrolling is the
  // cosmetic half of "show me", and losing the outline and the focus move
  // because a host has no `scrollIntoView` would be a poor trade.
  el.scrollIntoView?.({ behavior: 'smooth', block: 'center' });

  if (el instanceof HTMLElement) {
    // Focus is the accessible half of "show me": it moves the caret there for
    // a keyboard user, who cannot follow a coloured outline.
    try {
      el.focus({ preventScroll: true });
    } catch {
      /* not focusable; the outline still shows */
    }
  }

  doc.getElementById(HIGHLIGHT_ID)?.remove();

  const rect = el.getBoundingClientRect();
  const marker = doc.createElement('div');
  marker.id = HIGHLIGHT_ID;
  // `!important` throughout: this is a plain element in the page's document,
  // so a portal's own stylesheet could otherwise move it off the field it is
  // pointing at. A page can still hide it entirely, which costs the user a
  // visual aid and nothing more — unlike the overlay, this is not a control.
  //
  // `box-sizing: border-box` is load-bearing rather than tidy: without it the
  // 2px border lands outside the width we set, and the outline sits 4px wide
  // of the field on the right and bottom.
  marker.style.cssText = [
    'box-sizing:border-box!important',
    'position:fixed!important',
    `top:${rect.top - 3}px!important`,
    `left:${rect.left - 3}px!important`,
    `width:${rect.width + 6}px!important`,
    `height:${rect.height + 6}px!important`,
    'margin:0!important',
    'padding:0!important',
    'border:2px solid #1d4ed8!important',
    'border-radius:4px!important',
    'box-shadow:0 0 0 4px rgba(29,78,216,.18)!important',
    'pointer-events:none!important',
    'z-index:2147483646!important',
  ].join(';');

  doc.body.append(marker);
  setTimeout(() => marker.remove(), HIGHLIGHT_MS);
}

export interface EditOutcome {
  ok: boolean;
  /** What is in the field after the write — read back, not assumed. */
  value: string;
  reason?: string;
}

/**
 * Apply a correction the user typed in the panel.
 *
 * Read back afterwards for the same reason the fill engine does: a `maxLength`
 * or an input mask can quietly keep something other than what was sent, and
 * the review must show what the field really holds.
 */
export async function applyEdit(el: Element, value: string): Promise<EditOutcome> {
  const outcome = await fillField(el, value);
  const after = readValue(el);

  return {
    ok: outcome.ok,
    value: after,
    ...(outcome.reason ? { reason: outcome.reason } : {}),
  };
}
