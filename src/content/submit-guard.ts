/**
 * The submit guard (§ Phase 5) — P2 enforcement.
 *
 * **This is the only module in the codebase permitted to activate a submit
 * control**, and only when handed a valid, unexpired, unburned approval token
 * (CLAUDE.md rule 1). Everything else about the extension is a convenience;
 * this file is the promise.
 *
 * ## What it actually guarantees
 *
 * The guarantee is not "this page can never submit". It is: **no value the
 * extension filled reaches a submit without an explicit approval gesture.**
 * That distinction matters, and the difference is where the honesty lives:
 *
 *  - Capture-phase listeners on `click`, `submit`, and `keydown[Enter]` stop
 *    the ordinary paths, including a stray user click mid-run.
 *  - Patching `HTMLFormElement.prototype.submit` stops the scripted path — but
 *    only for code that reads the method *after* we install. The plan calls
 *    this best-effort and it means it: a page that cached the original
 *    reference before injection can still call it.
 *  - Because the extension injects on a user gesture rather than at
 *    `document_start`, a page that submits itself on load does so before we
 *    exist. Nothing of ours has been filled at that point, so the promise
 *    above still holds — but the page is not *prevented*, and saying otherwise
 *    would be a lie.
 *
 * The token is the real control. The patch is defence in depth.
 */

const SUBMIT_SELECTOR =
  'button[type="submit"], input[type="submit"], input[type="image"], button:not([type]), [role="button"]';

const SUBMIT_TEXT =
  /^(submit|final submit|save (and|&) submit|confirm (and|&) submit|proceed to submit|send application)$/i;

export interface ApprovalToken {
  /** Random 128-bit value issued by the review screen (§Phase 7). */
  value: string;
  expiresAt: number;
  /** The exact element the plan recorded as the submit control. */
  targetSelector: string;
}

export interface GuardState {
  installed: boolean;
  /** Set only between approval and the single permitted click. */
  armed: ApprovalToken | null;
  /** Number of activations blocked, for the audit log (P5). */
  blocked: number;
}

const state: GuardState = { installed: false, armed: null, blocked: 0 };

/**
 * Everything installed on the page, so it can be removed again.
 *
 * Not merely a test convenience: two live copies of the capture listeners would
 * *double-block* — the first permits an authorised submit and burns the token,
 * then the second sees an unarmed guard and blocks the very submission the
 * first just allowed. Aborting a run also needs a clean teardown.
 */
interface Installed {
  doc: Document;
  listeners: { type: string; handler: EventListener }[];
  restoreSubmit: (() => void) | null;
}
let installed: Installed | null = null;

type ToastFn = (message: string) => void;
let showToast: ToastFn = () => {};

export function setToastHandler(fn: ToastFn): void {
  showToast = fn;
}

export function guardState(): Readonly<GuardState> {
  return state;
}

// ---------------------------------------------------------------------------
// Arming
// ---------------------------------------------------------------------------

/**
 * Arm the guard for exactly one submission.
 *
 * Called only after the review screen's deliberate approval gesture. The token
 * carries its own expiry so a stale arm cannot be used later.
 */
export function arm(token: ApprovalToken): void {
  state.armed = token;
}

export function disarm(): void {
  state.armed = null;
}

function tokenValid(token: ApprovalToken | null): token is ApprovalToken {
  return token !== null && token.expiresAt > Date.now();
}

/**
 * Consume the token. Single-use.
 *
 * Burned on the **submission**, not on the click that starts it. A click on a
 * submit button raises a `submit` event as its default action, so burning at
 * click time would leave the guard unarmed for the second half of the very
 * activation it just authorised — and block it.
 */
function burn(): ApprovalToken | null {
  const token = state.armed;
  state.armed = null;
  return tokenValid(token) ? token : null;
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/** Does activating this element plausibly submit the form? */
export function isSubmitish(el: Element | null): boolean {
  if (!el) return false;

  const candidate = el.closest(SUBMIT_SELECTOR) ?? el;
  const tag = candidate.tagName.toLowerCase();
  const type = (candidate.getAttribute('type') ?? '').toLowerCase();

  if (type === 'submit' || type === 'image') return true;
  if (tag === 'button' && !candidate.hasAttribute('type')) return true;

  const text = (candidate.textContent ?? candidate.getAttribute('value') ?? '').trim();
  if (SUBMIT_TEXT.test(text)) return true;

  // ASP.NET postback links are submits wearing an anchor.
  const href = candidate.getAttribute('href') ?? '';
  const onclick = candidate.getAttribute('onclick') ?? '';
  if (/__doPostBack/.test(`${href} ${onclick}`)) return true;

  return false;
}

// ---------------------------------------------------------------------------
// Installation
// ---------------------------------------------------------------------------

function block(event: Event, what: string): void {
  event.preventDefault();
  event.stopImmediatePropagation();
  state.blocked += 1;
  showToast(
    `Submission blocked. ${what} AutoFill stops before submitting — review your details and approve first.`,
  );
}

/**
 * Install the guard. Idempotent; safe to call on every injection.
 *
 * Listeners are capture-phase so they run before the page's own handlers, which
 * is the only position from which a submit can actually be stopped.
 */
export function installSubmitGuard(doc: Document = document): void {
  if (state.installed) return;
  state.installed = true;
  installed = { doc, listeners: [], restoreSubmit: null };

  const on = (type: string, handler: EventListener): void => {
    doc.addEventListener(type, handler, true);
    installed?.listeners.push({ type, handler });
  };

  on('click', ((event: Event) => {
      const target = event.target as Element | null;
      if (!isSubmitish(target)) return;
      // A click is permitted but does not spend the token; the submission it
      // raises does.
      if (isPermitted(target, false)) return;
      block(event, 'You pressed a submit button.');
  }) as EventListener);

  on('submit', ((event: Event) => {
    if (isPermitted(event.target as Element | null, true)) return;
    block(event, 'The page tried to submit a form.');
  }) as EventListener);

  on('keydown', ((event: KeyboardEvent) => {
      if (event.key !== 'Enter') return;
      const target = event.target as Element | null;
      // Enter in a textarea is a newline, not a submit.
      if (target?.tagName.toLowerCase() === 'textarea') return;
      if (!target?.closest('form')) return;
      if (isPermitted(target, true)) return;
      block(event, 'You pressed Enter inside a form.');
  }) as EventListener);

  patchFormSubmit(doc);
}

/** Remove every listener and restore the patched prototype. */
export function uninstallSubmitGuard(): void {
  if (installed) {
    for (const { type, handler } of installed.listeners) {
      installed.doc.removeEventListener(type, handler, true);
    }
    installed.restoreSubmit?.();
    installed = null;
  }
  state.installed = false;
  state.armed = null;
}

/**
 * Is this activation the one the approval token authorised?
 *
 * Requires a live token *and* that the element is the one recorded in the plan.
 * An approval for "Final Submit" does not authorise a click on "Withdraw
 * Application".
 *
 * `consume` distinguishes the two halves of one activation: a click is merely
 * *permitted*, while the submission it causes is what actually spends the
 * token. Spending at click time would unarm the guard before the resulting
 * `submit` event reached it.
 */
function isPermitted(target: Element | null, consume: boolean): boolean {
  const token = state.armed;
  if (!tokenValid(token)) return false;
  if (!target) return false;

  // A submit event targets the form; the token names the button inside it.
  const intended =
    matchesTarget(target, token.targetSelector) ||
    (consume && containsTarget(target, token.targetSelector));
  if (!intended) return false;

  if (consume) burn();
  return true;
}

/** True when `target` is the form containing the token's recorded control. */
function containsTarget(target: Element, selector: string): boolean {
  if (!selector) return false;
  try {
    const expected = target.ownerDocument.querySelector(selector);
    return expected !== null && target.contains(expected);
  } catch {
    return false;
  }
}

function matchesTarget(target: Element, selector: string): boolean {
  if (!selector) return false;
  try {
    const expected = target.ownerDocument.querySelector(selector);
    if (!expected) return false;
    return expected === target || expected.contains(target) || target.contains(expected);
  } catch {
    return false;
  }
}

/**
 * Patch `HTMLFormElement.prototype.submit`.
 *
 * Documented as best-effort: a page that captured the original method before we
 * installed keeps a working reference. Recorded here rather than hidden, and
 * asserted by the adversarial e2e test.
 */
function patchFormSubmit(doc: Document): void {
  const win = doc.defaultView as (Window & typeof globalThis) | null;
  if (!win) return;

  const proto = win.HTMLFormElement?.prototype;
  if (!proto) return;

  const original = proto.submit;
  if ((original as { __afGuarded?: boolean }).__afGuarded) return;

  const guarded = function guardedSubmit(this: HTMLFormElement): void {
    const token = state.armed;
    if (tokenValid(token)) {
      burn();
      original.call(this);
      return;
    }
    state.blocked += 1;
    showToast(
      'Submission blocked. A script on this page tried to submit the form. ' +
        'AutoFill stops before submitting — review your details and approve first.',
    );
  };
  (guarded as { __afGuarded?: boolean }).__afGuarded = true;

  try {
    proto.submit = guarded;
    if (installed) installed.restoreSubmit = () => {
      proto.submit = original;
    };
  } catch {
    // A frozen prototype means we cannot patch. The token still governs every
    // path we control; log nothing to the page.
  }
}

/**
 * Perform the one authorised submission.
 *
 * ## Every exit disarms
 *
 * Found by the Phase B attack suite. Each early return used to leave
 * `state.armed` set, and the consequence was narrow but real: the recorded
 * element goes missing — a postback re-rendering the form is the ordinary way
 * that happens — we bail out, and the guard stays armed for the rest of the
 * ninety seconds. If the element then comes *back* under the same selector, a
 * page-initiated click on it would be permitted, and nobody approved that
 * activation.
 *
 * So an approval that cannot be spent is an approval that is thrown away. The
 * user can approve again; a live token nobody is watching is the thing that
 * must not exist.
 */
export function submitWithApproval(token: ApprovalToken, doc: Document = document): boolean {
  if (!tokenValid(token)) {
    disarm();
    return false;
  }
  if (state.armed?.value !== token.value) {
    // Not our token. Whatever is armed is no longer trustworthy either — the
    // caller and the guard disagree about what was approved.
    disarm();
    return false;
  }

  const target = doc.querySelector<HTMLElement>(token.targetSelector);
  if (!target) {
    disarm();
    return false;
  }

  // The token stays armed across the click so the capture listeners let the
  // whole activation through; the submit event it raises spends it. The
  // `finally` guarantees nothing live is left behind even if a page handler
  // throws mid-submit.
  try {
    target.click();
  } finally {
    state.armed = null;
  }
  return true;
}

/** Test seam. Tears the guard down properly rather than just clearing flags. */
export function __resetGuardForTests(): void {
  uninstallSubmitGuard();
  state.blocked = 0;
  showToast = () => {};
}
