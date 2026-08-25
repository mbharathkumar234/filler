/**
 * Text normalisation for matching (§ Phase 4).
 *
 * Portals write the same field a dozen ways: "Father's Name", "FATHER NAME",
 * "Father/Guardian Name*", "पिता का नाम / Father's Name", `txtFatherNm`. All of
 * those have to reduce to comparable tokens before any rule can fire.
 *
 * Pure functions, no DOM — this is the layer the whole matcher is built on and
 * it must be cheap enough to run against every field on every page.
 */

/** Prefixes portals bolt onto control names: txtName, ddlState, hdnPan. */
const CONTROL_PREFIX =
  /^(txt|ddl|dll|chk|cbo|cb|rdo|rb|lst|lbl|hdn|hid|fu|fup|btn|inp|input|field|frm|form|ctl|edit|sel|opt)[_\-\s]?/i;

/** Words that carry no matching signal and only add noise. */
const STOP_WORDS = new Set([
  'the', 'a', 'an', 'of', 'in', 'as', 'is', 'to', 'for', 'your', 'my', 'please',
  'enter', 'select', 'choose', 'type', 'input', 'field', 'value', 'here',
  'details', 'detail', 'information', 'info', 'kindly', 'provide',
]);

/**
 * Bilingual labels are usually "Hindi / English". Both halves are kept — the
 * synonym dictionary carries Devanagari entries too, so either half can match.
 */
export function splitBilingual(label: string): string[] {
  const parts = label.split(/\s*[/|｜]\s*|\s+–\s+|\s+—\s+/).map((p) => p.trim());
  return parts.filter((p) => p.length > 0);
}

/**
 * Lowercase, strip punctuation and diacritic-insensitive noise, collapse space.
 * Devanagari combining marks are preserved (`\p{M}`) — stripping them shatters
 * Hindi words into single letters.
 */
export function normaliseText(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/['’`]/g, '')
    .replace(/[^\p{L}\p{M}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Split an identifier like `txtFatherName` / `applicant_dob` into words. */
export function identifierTokens(raw: string): string[] {
  if (!raw) return [];
  const withoutPrefix = raw.replace(CONTROL_PREFIX, '');
  return normaliseText(
    withoutPrefix
      // ASP.NET container names: keep the leaf.
      .split(/[$:]/)
      .pop()!
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
      .replace(/[_\-.]+/g, ' '),
  )
    .split(' ')
    .filter((token) => (token.length > 1 || /^\d$/.test(token)) && !STOP_WORDS.has(token));
}

/**
 * Meaningful words from a human label.
 *
 * Single-character tokens are dropped as noise **except digits**: "Address
 * Line 1" and "Address Line 2" are different fields, and dropping the index
 * makes them indistinguishable — the matcher would then have to guess between
 * two keys on every form with a two-line address.
 */
export function labelTokens(label: string): string[] {
  return normaliseText(label)
    .split(' ')
    .filter((token) => (token.length > 1 || /^\d$/.test(token)) && !STOP_WORDS.has(token));
}

/**
 * A canonical key for exact lookup: tokens sorted and joined.
 *
 * Sorting means "Name of Father" and "Father Name" collide, which is what we
 * want — portals reorder the same words freely.
 */
export function canonicalForm(value: string): string {
  return labelTokens(value).sort().join(' ');
}

/**
 * Tokens too generic to justify a match by themselves.
 *
 * "Reference Code" shares "code" with "PIN Code" and "IFSC Code"; "Batch
 * Number" shares "number" with half the dictionary. Letting these carry a
 * partial match is how a matcher produces confident nonsense, so partial
 * coverage requires at least one *distinctive* shared token.
 */
export const GENERIC_TOKENS = new Set([
  'name', 'number', 'code', 'id', 'no', 'date', 'type', 'address', 'line',
  'card', 'account', 'certificate', 'upload', 'total', 'year', 'status',
]);

export function hasDistinctiveOverlap(a: string[], b: string[]): boolean {
  const set = new Set(b);
  return a.some((token) => set.has(token) && !GENERIC_TOKENS.has(token));
}

/** Jaccard overlap of two token sets. 1 = identical, 0 = disjoint. */
export function tokenOverlap(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  let shared = 0;
  for (const token of setA) if (setB.has(token)) shared += 1;
  return shared / (setA.size + setB.size - shared);
}

/**
 * How much of `needle` is covered by `haystack`.
 *
 * Asymmetric on purpose: a label "Permanent Address Line 1" fully contains the
 * synonym "address line 1", and that should score as a strong match even though
 * the label carries extra words.
 */
export function coverage(needle: string[], haystack: string[]): number {
  if (needle.length === 0) return 0;
  const set = new Set(haystack);
  let found = 0;
  for (const token of needle) if (set.has(token)) found += 1;
  return found / needle.length;
}

/** Levenshtein-based similarity for single-token typos ("mobil" vs "mobile"). */
export function similarity(a: string, b: string): number {
  if (a === b) return 1;
  const longer = a.length >= b.length ? a : b;
  const shorter = a.length >= b.length ? b : a;
  if (longer.length === 0) return 1;
  if (longer.length - shorter.length > 3) return 0;

  const distances = Array.from({ length: shorter.length + 1 }, (_, i) => i);
  for (let i = 1; i <= longer.length; i += 1) {
    let previous = distances[0]!;
    distances[0] = i;
    for (let j = 1; j <= shorter.length; j += 1) {
      const current = distances[j]!;
      distances[j] =
        longer[i - 1] === shorter[j - 1]
          ? previous
          : 1 + Math.min(previous, distances[j]!, distances[j - 1]!);
      previous = current;
    }
  }
  return 1 - distances[shorter.length]! / longer.length;
}
