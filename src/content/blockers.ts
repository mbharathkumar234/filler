/**
 * Blocker detection (§ Phase 6) — P4 enforcement.
 *
 * ## What this file is allowed to do
 *
 * Notice that a security control **exists**, say where it is, and hand control
 * back to the user. That is the entire job.
 *
 * ## What this file must never do
 *
 * Read one. Not the CAPTCHA image, not the OTP a user typed, not the text of a
 * challenge, not an eSign document. There is no code path here that touches an
 * input's `value`, rasterises an image, fetches a resource, or ships anything
 * from a widget anywhere. `blockers.test.ts` asserts that against this file's
 * own source text, because "we intended not to" is not a control and a future
 * edit is exactly how that intention would be lost.
 *
 * The user solves the CAPTCHA. The user reads the OTP off their phone and
 * types it. The user signs. We wait, and then we check whether the page reset
 * what we had already filled.
 *
 * Every message shown to the user comes from the frozen `INSTRUCTIONS` table
 * below — never from page text. A hostile page must not be able to write the
 * words in our own overlay.
 */

import type { BlockReason } from '@/shared/types';
import { findFrameBlockers } from './harvester';
import { buildSelectors } from './selectors';

export interface BlockerFinding {
  type: BlockReason;
  /** Where it is, so the overlay can point the user at it. */
  selector: string;
  /**
   * Why we think so — an attribute *name*, a pattern name, or a hostname.
   * Never an attribute value that could carry challenge content, and never
   * anything a user typed.
   */
  evidence: string;
  /** Constant, from the table below. Never page-derived. */
  instruction: string;
}

/**
 * What the user is told, per blocker. Frozen and page-independent.
 *
 * These are written to be actionable rather than apologetic: the user has hit
 * a step that is theirs to do, and the sentence should say what that step is.
 */
export const INSTRUCTIONS: Readonly<Record<BlockReason, string>> = Object.freeze({
  captcha:
    'This page has a CAPTCHA. Please complete it yourself — AutoFill will not read or solve it. Press "I have completed this" when you are done.',
  otp: 'This page is asking for a one-time code. Please read it from your phone or email and type it in yourself. Press "I have completed this" when you are done.',
  esign:
    'This step is an electronic signature. Please complete it yourself — AutoFill never signs on your behalf. Press "I have completed this" when you are done.',
  payment:
    'This step is a payment. Please complete it yourself. AutoFill will not enter card, UPI, or bank credentials.',
  unknown_widget:
    'Part of this page comes from another site and AutoFill cannot see inside it. Please check it yourself before continuing.',
});

// ---------------------------------------------------------------------------
// Patterns
// ---------------------------------------------------------------------------

/** Widget vendors whose presence means "a human must act". */
const CAPTCHA_HOSTS = /recaptcha|hcaptcha|turnstile|arkoselabs|funcaptcha|geetest|captcha/i;

/** Container conventions the big three CAPTCHA vendors document. */
const CAPTCHA_CONTAINERS = '.g-recaptcha, .h-captcha, .cf-turnstile, [data-sitekey], #recaptcha';

/** An image *is* the challenge on most Indian government portals. */
const CAPTCHA_IMAGE_HINT = /captcha|verifycode|securityimage|imgcode/i;

/**
 * One-time codes, as a phrase.
 *
 * `autocomplete="one-time-code"` is the standards-track declaration; the rest
 * is what portals actually ship.
 */
const OTP_PHRASE =
  /one.?time.?(code|password)|verification.?code|security.?code|mobile.?code|email.?code|txn.?pin/i;

/**
 * "otp" as a whole token — `txtOTP`, `otp_field`, `hdnOtpValue`.
 *
 * It has to be tokenised rather than searched for, twice over. A bare `/otp/`
 * matches inside `footprint` and `hotpoint`; a word-boundary regex like
 * `[^a-z]otp` silently fails under the `i` flag, because case-insensitive
 * matching folds `T` into the excluded `a-z` range and so rejects the very
 * `txtOTP` it was written to catch. Splitting first is the only version that
 * is right in both directions.
 */
const OTP_TOKENS = new Set(['otp', 'vcode', 'otpcode']);

const ESIGN_HOSTS = /digilocker\.gov\.in|esign|emudhra|nsdl|cdac|protean|signzy/i;
const ESIGN_TEXT = /\be-?sign\b|digilocker|aadhaar\s*(otp|e-?sign)|digital\s*signature/i;

const PAYMENT_HOSTS =
  /razorpay|payu|billdesk|ccavenue|paytm|instamojo|sbiepay|atomtech|worldline|cashfree|phonepe|easebuzz|pgi\.|paygov/i;
const PAYMENT_TEXT = /\b(pay\s*now|make\s*payment|proceed\s*to\s*pay|payment\s*gateway)\b/i;

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/**
 * Find every reason this run must stop and hand back to the user.
 *
 * Read-only, like the harvester: no attribute is written, no event dispatched.
 * Order is stable so the overlay does not flicker between equal candidates.
 */
export function detectBlockers(root: Document | ShadowRoot = document): BlockerFinding[] {
  const findings: BlockerFinding[] = [];
  const seen = new Set<string>();

  const add = (type: BlockReason, el: Element, evidence: string): void => {
    const selector = buildSelectors(el, '', root)[0] ?? el.tagName.toLowerCase();
    const dedupe = `${type}|${selector}`;
    if (seen.has(dedupe)) return;
    seen.add(dedupe);
    findings.push({ type, selector, evidence, instruction: INSTRUCTIONS[type] });
  };

  // 1. Vendor iframes and containers.
  for (const el of root.querySelectorAll('iframe, frame')) {
    const src = el.getAttribute('src') ?? '';
    const title = el.getAttribute('title') ?? '';
    if (CAPTCHA_HOSTS.test(`${src} ${title}`)) add('captcha', el, hostOf(src) || 'iframe title');
    else if (ESIGN_HOSTS.test(src)) add('esign', el, hostOf(src));
    else if (PAYMENT_HOSTS.test(src)) add('payment', el, hostOf(src));
  }

  for (const el of root.querySelectorAll(CAPTCHA_CONTAINERS)) {
    add('captcha', el, 'vendor container');
  }

  // 2. The image-based CAPTCHA. We record that it is there. We do not look at
  //    it — no canvas, no bitmap, no request for its bytes.
  for (const el of root.querySelectorAll('img')) {
    const identity = `${el.getAttribute('id') ?? ''} ${el.getAttribute('class') ?? ''} ${el.getAttribute('alt') ?? ''} ${el.getAttribute('src') ?? ''}`;
    if (CAPTCHA_IMAGE_HINT.test(identity)) add('captcha', el, 'image marked as a captcha');
  }

  // 3. One-time-code inputs. Identified by their *declaration* — name, id,
  //    placeholder, autocomplete. Never by what is in them.
  for (const el of root.querySelectorAll('input')) {
    if (el.getAttribute('autocomplete') === 'one-time-code') {
      add('otp', el, 'autocomplete="one-time-code"');
      continue;
    }
    const identity = [
      el.getAttribute('name'),
      el.getAttribute('id'),
      el.getAttribute('placeholder'),
      el.getAttribute('aria-label'),
    ]
      .filter(Boolean)
      .join(' ');
    if (looksLikeOtpField(identity)) add('otp', el, 'field named as a one-time code');
    else if (CAPTCHA_IMAGE_HINT.test(identity)) add('captcha', el, 'field named as a captcha answer');
  }

  // 4. eSign and payment steps, from links, forms and buttons.
  for (const el of root.querySelectorAll('a[href], form[action], button, input[type="button"]')) {
    const url = el.getAttribute('href') ?? el.getAttribute('action') ?? '';
    const text = labelTextOf(el);

    if (ESIGN_HOSTS.test(url)) add('esign', el, hostOf(url));
    else if (PAYMENT_HOSTS.test(url)) add('payment', el, hostOf(url));
    else if (ESIGN_TEXT.test(text)) add('esign', el, 'control labelled as e-sign');
    else if (PAYMENT_TEXT.test(text)) add('payment', el, 'control labelled as payment');
  }

  // 5. Frames we cannot read at all. The harvester already works this out
  //    while mapping the page; reusing it keeps one owner for the question.
  for (const candidate of findFrameBlockers(root)) {
    const type: BlockReason = candidate.type === 'otp' ? 'otp' : candidate.type;
    const dedupe = `${type}|${candidate.selector}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    findings.push({
      type,
      selector: candidate.selector,
      evidence: 'cross-origin frame',
      instruction: INSTRUCTIONS[type],
    });
  }

  return findings;
}

/**
 * The most urgent blocker, or null.
 *
 * Ordered by how completely it stops us: a payment or signature is a step we
 * will never take, a CAPTCHA and an OTP are steps the user takes now, and an
 * unreadable frame is merely something to look at.
 */
const URGENCY: readonly BlockReason[] = ['payment', 'esign', 'captcha', 'otp', 'unknown_widget'];

export function primaryBlocker(findings: readonly BlockerFinding[]): BlockerFinding | null {
  for (const type of URGENCY) {
    const found = findings.find((finding) => finding.type === type);
    if (found) return found;
  }
  return null;
}

/**
 * Has the blocker the run stopped for gone away?
 *
 * Deliberately strict about *visibility*, not just presence: portals hide the
 * CAPTCHA panel rather than removing it once it is satisfied. Answering "is it
 * still in the DOM" would leave the run stuck forever on those pages.
 */
export function blockerCleared(
  type: BlockReason,
  root: Document | ShadowRoot = document,
): boolean {
  return !detectBlockers(root).some(
    (finding) => finding.type === type && isOnScreen(elementFor(finding.selector, root)),
  );
}

function elementFor(selector: string, root: Document | ShadowRoot): Element | null {
  try {
    return selector.startsWith('/') || selector.startsWith('(')
      ? ((root.ownerDocument ?? (root as Document)).evaluate(
          selector,
          root as Node,
          null,
          9,
          null,
        ).singleNodeValue as Element | null)
      : root.querySelector(selector);
  } catch {
    return null;
  }
}

function isOnScreen(el: Element | null): boolean {
  if (!el) return false;
  const style = el.ownerDocument.defaultView?.getComputedStyle(el);
  if (style && (style.display === 'none' || style.visibility === 'hidden')) return false;
  const rect = el.getBoundingClientRect?.();
  // jsdom reports every rect as 0x0, so an absent layout engine must not be
  // read as "hidden" — only an explicit style is conclusive there.
  if (rect && (rect.width > 0 || rect.height > 0)) return true;
  return style === undefined || (style.display !== 'none' && style.visibility !== 'hidden');
}

// ---------------------------------------------------------------------------
// § Phase 6 "Should Achieve"
// ---------------------------------------------------------------------------

/**
 * Does this look like the portal logged us out?
 *
 * A password field appearing on what should be an application form is the
 * signal. The run cannot continue through a login — the user has to sign in
 * themselves (we hold no portal credentials, by design) — so the panel offers
 * "log in, then press resume" rather than pretending to retry.
 */
export function looksLikeSessionExpiry(doc: Document = document): boolean {
  const hasPassword = doc.querySelector('input[type="password"]') !== null;
  if (!hasPassword) return false;
  const context = `${doc.location?.pathname ?? ''} ${doc.title}`;
  return /log ?in|sign ?in|session|expired|unauthori[sz]ed/i.test(context);
}

export interface DraftControl {
  selector: string;
  label: string;
}

/**
 * Find the portal's own "Save as draft", if it has one.
 *
 * **Surfaced, never pressed.** CLAUDE.md rule 1 reserves clicking a final-action
 * control to the submit guard, and a draft save is a state-changing action on
 * the user's account. So this returns a pointer for the panel to offer, and the
 * user decides — which is also the honest division of labour under P1.
 */
export function findDraftControl(doc: Document = document): DraftControl | null {
  const pattern = /save\s*(as\s*)?draft|save\s*(and|&)\s*(continue|exit|later)|save\s*for\s*later/i;

  for (const el of doc.querySelectorAll('button, input[type="button"], input[type="submit"], a[href]')) {
    const label = labelTextOf(el);
    if (!pattern.test(label)) continue;
    const id = el.getAttribute('id');
    const name = el.getAttribute('name');
    const selector = id
      ? `#${cssEscape(id)}`
      : name
        ? `${el.tagName.toLowerCase()}[name="${cssEscape(name)}"]`
        : '';
    if (!selector) continue;
    return { selector, label: label.trim().slice(0, 60) };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/**
 * Split an identifier the way a human reads it: `txtOTPCode` → txt, otp, code.
 *
 * Local rather than borrowed from `matching/normalise.ts` on purpose — the
 * matching rules must not be bundled into a hostile page's tab, and this is
 * eight lines.
 */
export function identifierTokens(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((token) => token.toLowerCase());
}

export function looksLikeOtpField(identity: string): boolean {
  if (OTP_PHRASE.test(identity)) return true;
  return identifierTokens(identity).some((token) => OTP_TOKENS.has(token));
}

function labelTextOf(el: Element): string {
  return (el.textContent ?? el.getAttribute('value') ?? el.getAttribute('aria-label') ?? '').trim();
}

function hostOf(url: string): string {
  try {
    return new URL(url, 'https://example.invalid').hostname;
  } catch {
    return 'unknown host';
  }
}

function cssEscape(value: string): string {
  return typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(value) : value;
}
