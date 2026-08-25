/**
 * Form fingerprinting (§5).
 *
 *   "stable hash of {origin, pathname, sorted(field name/id/label tokens),
 *    form action} — deliberately excludes volatile ASP.NET __VIEWSTATE,
 *    GUID-ish ids, and index suffixes."
 *
 * The fingerprint is the key a paused run is stored under. Get it wrong in one
 * direction and a postback looks like a different form, losing the run; wrong
 * in the other and two different forms collide, resuming the wrong data into
 * the wrong page. So it has to be stable across the churn a portal creates on
 * its own, and sensitive to an actual change of form.
 *
 * `FillPlan` construction proper lands in Phase 5; this is the identity half,
 * which Phase 3 needs in order to key a harvest.
 */

import type { FieldDescriptor } from '@/shared/types';
import { looksUnstable } from '@/content/selectors';

/** Query/hidden fields that change every request and must never be hashed. */
const VOLATILE_FIELDS = /^(__viewstate|__viewstategenerator|__eventvalidation|__requestverificationtoken|csrf|authenticity_token|_token|nonce)/i;

/** Trailing index suffixes a framework appends when rendering repeated rows. */
const INDEX_SUFFIX = /[_-]?\d+$/;

export interface FingerprintInput {
  url: string;
  formAction?: string | null;
  fields: Pick<FieldDescriptor, 'labelText' | 'selectors' | 'tag'>[];
  /** Raw name/id per field, when available — more stable than a selector. */
  identifiers?: string[];
  /** 1-based wizard step, folded in so step 3 is not mistaken for step 1. */
  step?: number | null;
}

/**
 * Normalise one identifier into a fingerprint token.
 *
 * Returns null for anything too volatile to contribute: generated ids, the
 * ASP.NET machinery, and anything that is only digits after stripping.
 */
export function normaliseToken(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;
  if (VOLATILE_FIELDS.test(value)) return null;

  // ASP.NET container prefixes: keep only the leaf.
  const leaf = value.split(/[$:]/).pop() ?? value;

  const stripped = leaf
    .replace(INDEX_SUFFIX, '')
    .replace(/[_-]+/g, '')
    .toLowerCase();

  if (stripped.length < 2) return null;
  if (/^\d+$/.test(stripped)) return null;
  if (looksUnstable(leaf) && !/[a-z]{3}/i.test(stripped)) return null;

  return stripped;
}

/** Tokens from a label: words, lowercased, punctuation dropped. */
export function labelTokens(labelText: string): string[] {
  return labelText
    .toLowerCase()
    // \p{M} keeps combining marks: without it, Devanagari matras are stripped
    // as punctuation and "पिता का नाम" shatters into single letters.
    .replace(/[^\p{L}\p{M}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 2)
    .slice(0, 4);
}

/**
 * Build the canonical string a fingerprint hashes.
 *
 * Exported separately from `fingerprintForm` so it can be asserted directly:
 * a hash tells you two inputs differ, but not *why*, and "why" is what you need
 * when a resumed run fails to find its state.
 */
export function fingerprintSource(input: FingerprintInput): string {
  let origin: string;
  let pathname = '';
  try {
    const url = new URL(input.url);
    origin = url.origin;
    // Path segments that are pure ids vary per application; drop them.
    pathname = url.pathname
      .split('/')
      .filter((segment) => segment && !/^\d+$/.test(segment) && !/^[0-9a-f]{16,}$/i.test(segment))
      .join('/');
  } catch {
    origin = input.url;
  }

  const tokens = new Set<string>();

  for (const identifier of input.identifiers ?? []) {
    const token = normaliseToken(identifier);
    if (token) tokens.add(token);
  }

  for (const field of input.fields) {
    for (const word of labelTokens(field.labelText)) tokens.add(word);
  }

  const action = normaliseAction(input.formAction ?? '');

  return [
    origin,
    pathname,
    action,
    input.step === null || input.step === undefined ? '' : `step${input.step}`,
    [...tokens].sort().join(','),
  ].join('|');
}

function normaliseAction(action: string): string {
  if (!action) return '';
  try {
    const url = new URL(action, 'https://example.invalid');
    // Query strings on the action carry session ids; the path is the identity.
    return url.pathname;
  } catch {
    return action.split('?')[0] ?? '';
  }
}

/** SHA-256 of the canonical source, hex, truncated to 32 chars. */
export async function fingerprintForm(input: FingerprintInput): Promise<string> {
  const source = fingerprintSource(input);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(source));
  return [...new Uint8Array(digest)]
    .slice(0, 16)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}
