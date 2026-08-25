/**
 * The redaction layer (§ Phase 8) — P3 enforcement.
 *
 * **Nothing reaches a model except through this file.** CLAUDE.md rule 2 and
 * the lint boundary in `eslint.config.js` both say so: this module and
 * `llm-client.ts` may not import from `vault/` or `documents/`, so user values
 * and document bytes are not merely unsent but *unreachable* from here.
 *
 * ## The part that is easy to get wrong
 *
 * "Don't send the vault" is the obvious half, and the module boundary handles
 * it. The half that actually needs code is this: **the page itself contains
 * the user's data.** A portal that has already been filled in — or that
 * greets the user by name, or shows a masked Aadhaar beside the field, or
 * carries a session id in a nearby paragraph — puts PII into exactly the
 * `labelText`, `nearbyText` and `placeholder` fields the plan says are safe to
 * send.
 *
 * They are safe to send *after scrubbing*. So every string that leaves here
 * passes `scrubText`, which replaces anything value-shaped with a placeholder.
 * That costs a little matching signal — "Aadhaar Number" survives, "Aadhaar:
 * 2345 6789 0123" becomes "Aadhaar: [number]" — and it is the right trade:
 * the model needs to know the field is *for* an Aadhaar, never what the
 * Aadhaar is.
 *
 * ## What is deliberately not sent
 *
 * The URL. It is not in the plan's payload contract, and it is the single most
 * identifying thing available: which portals a person is applying to is
 * sensitive on its own, and portal URLs routinely carry an application number.
 * The model is given a DOM skeleton and a closed vocabulary. It does not need
 * to know whose form it is.
 */

import type { FieldDescriptor } from '@/shared/types';

/**
 * The only shape that may cross the network boundary.
 *
 * Deliberately not `FieldDescriptor`: a structurally narrower type means a
 * future field added to the descriptor — a value, a filename, anything — does
 * not silently start being transmitted. Every property here was chosen once,
 * on purpose, and adding another is a visible edit to this file.
 */
export interface RedactedField {
  ref: string;
  label: string;
  name?: string;
  type?: string;
  maxLength?: number;
  nearby?: string;
  /** Option *text* only, capped — never option values, which encode data. */
  options?: string[];
  required?: boolean;
}

export interface RedactionReport {
  fields: RedactedField[];
  /**
   * What kinds of thing were scrubbed, and how many. Counts, never content —
   * a report that quoted what it removed would be a leak with a nicer name.
   */
  redacted: Record<string, number>;
}

// ---------------------------------------------------------------------------
// Caps
// ---------------------------------------------------------------------------

const MAX_LABEL = 120;
const MAX_NEARBY = 200;
const MAX_OPTION = 40;
const MAX_OPTIONS = 20;
const MAX_NAME = 80;

// ---------------------------------------------------------------------------
// Scrubbing
// ---------------------------------------------------------------------------

/**
 * Value-shaped patterns, most specific first.
 *
 * Order matters: an Aadhaar must be recognised as an Aadhaar before the
 * generic long-digit-run rule turns it into `[number]`, so the report says
 * what was actually removed.
 *
 * These are all *value* shapes. Label words — "Aadhaar", "PAN", "IFSC",
 * "Mobile Number" — are not touched, because they are what the model needs.
 */
const PATTERNS: ReadonlyArray<{ name: string; re: RegExp; token: string }> = [
  { name: 'email', re: /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi, token: '[email]' },
  { name: 'aadhaar', re: /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g, token: '[id-number]' },
  { name: 'pan', re: /\b[A-Z]{5}\d{4}[A-Z]\b/g, token: '[id-number]' },
  { name: 'ifsc', re: /\b[A-Z]{4}0[A-Z0-9]{6}\b/g, token: '[bank-code]' },
  { name: 'phone', re: /(?:\+91[\s-]?)?\b[6-9]\d{9}\b/g, token: '[phone]' },
  { name: 'date', re: /\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b/g, token: '[date]' },
  {
    name: 'url',
    re: /\bhttps?:\/\/\S+/gi,
    token: '[url]',
  },
  // Anything else long enough to be an identifier: account numbers, reference
  // numbers, enrolment ids. Four digits is the floor because a portal saying
  // "6 digits" or "Step 2 of 3" must survive intact.
  { name: 'number', re: /\b[A-Z0-9]*\d[A-Z0-9]*\b/gi, token: '[number]' },
];

/** A token that is only long digits/alphanumerics is a value, not a label. */
const LONG_TOKEN = /^(?=.*\d)[A-Za-z0-9]{4,}$/;

export interface ScrubResult {
  text: string;
  /** Pattern name -> how many were removed. */
  hits: Record<string, number>;
}

/**
 * Remove anything that looks like a value from a piece of page text.
 *
 * Errs toward removing. A label that loses a number is a slightly weaker
 * matching signal; a value that survives is a P3 breach. Given that trade
 * there is only one direction to lean.
 */
export function scrubText(input: string): ScrubResult {
  const hits: Record<string, number> = {};
  let text = input;

  for (const { name, re, token } of PATTERNS) {
    if (name === 'number') continue; // handled token-wise below
    text = text.replace(re, () => {
      hits[name] = (hits[name] ?? 0) + 1;
      return token;
    });
  }

  // Generic identifiers, token by token, so "Step 2 of 3" and "(6 digits)"
  // survive while "REF20240831771" does not.
  text = text
    .split(/(\s+)/)
    .map((piece) => {
      const bare = piece.replace(/^[^\w]+|[^\w]+$/g, '');
      if (bare.length === 0 || !LONG_TOKEN.test(bare)) return piece;
      hits.number = (hits.number ?? 0) + 1;
      return piece.replace(bare, '[number]');
    })
    .join('');

  // A final sweep for digit runs buried inside a token that the pass above
  // could not see: `user_9876543210_name` is one word by `\w` rules, so the
  // whole-token test never fires on it. Four is the floor for the same reason
  // as above — "Step 2 of 3" and "(6 digits)" must survive.
  text = text.replace(/\d{4,}/g, () => {
    hits.number = (hits.number ?? 0) + 1;
    return '[number]';
  });

  return { text: collapse(text), hits };
}

function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

// ---------------------------------------------------------------------------
// Building the payload
// ---------------------------------------------------------------------------

/**
 * Turn descriptors into the only thing that may be transmitted.
 *
 * Skips fields with nothing useful to say — an unlabelled, unnamed input gives
 * the model nothing to work with and costs tokens to ask about.
 */
export function redactFields(fields: readonly FieldDescriptor[]): RedactionReport {
  const redacted: Record<string, number> = {};
  const out: RedactedField[] = [];

  const note = (hits: Record<string, number>): void => {
    for (const [name, count] of Object.entries(hits)) {
      redacted[name] = (redacted[name] ?? 0) + count;
    }
  };

  for (const field of fields) {
    const label = scrubText(field.labelText);
    const name = scrubText(identifierOf(field));
    const nearby = scrubText(field.nearbyText);
    const placeholder = scrubText(field.placeholder ?? '');

    note(label.hits);
    note(name.hits);
    note(nearby.hits);
    note(placeholder.hits);

    // The placeholder is folded into the label rather than sent separately:
    // it is a labelling hint, and a portal that pre-fills a placeholder with
    // the user's own details has already been scrubbed above.
    const labelText = clip(label.text || placeholder.text, MAX_LABEL);
    const identifier = clip(name.text, MAX_NAME);

    if (labelText === '' && identifier === '') continue;

    const options = optionTexts(field, note);

    out.push({
      ref: field.ref,
      label: labelText,
      ...(identifier === '' ? {} : { name: identifier }),
      ...(field.type === undefined ? {} : { type: field.type }),
      ...(field.maxLength === undefined ? {} : { maxLength: field.maxLength }),
      ...(nearby.text === '' ? {} : { nearby: clip(nearby.text, MAX_NEARBY) }),
      ...(options.length === 0 ? {} : { options }),
      ...(field.required ? { required: true } : {}),
    });
  }

  return { fields: out, redacted };
}

/**
 * Option *text*, scrubbed and capped.
 *
 * Never option `value`s. A portal's option values are frequently codes that
 * encode something about the user's record, and the visible text is the part
 * that carries the meaning the model needs anyway.
 */
function optionTexts(
  field: FieldDescriptor,
  note: (hits: Record<string, number>) => void,
): string[] {
  if (!field.options || field.options.length === 0) return [];

  const texts: string[] = [];
  for (const option of field.options.slice(0, MAX_OPTIONS)) {
    const scrubbed = scrubText(option.text);
    note(scrubbed.hits);
    if (scrubbed.text !== '') texts.push(clip(scrubbed.text, MAX_OPTION));
  }
  return texts;
}

/**
 * The name or id of a field, as the harvester recorded it.
 *
 * Read off the ranked selectors, because `FieldDescriptor` carries no
 * dedicated property for it — and the plan's payload contract lists `name` as
 * one of the things the model is given. An XPath or structural selector yields
 * nothing here, which is correct: a path is a description of the page, not an
 * identifier the model can reason about.
 */
export function identifierOf(field: FieldDescriptor): string {
  for (const selector of field.selectors) {
    const id = /^#(.+)$/.exec(selector);
    if (id?.[1]) return id[1];
    const name = /\[name="(.+)"\]$/.exec(selector);
    if (name?.[1]) return name[1];
  }
  return '';
}
