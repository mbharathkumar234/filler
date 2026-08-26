/**
 * The value guard (§ Phase 8) — the second half of P3.
 *
 * ## Why this file exists at all
 *
 * `redaction.ts` cannot solve the whole problem, and the leak suite proved it.
 * That module scrubs anything *value-shaped* out of page text — Aadhaars, PANs,
 * emails, account numbers — and it cannot scrub a name, because a name has no
 * shape. "Welcome back, Ravi Kumar Chandrasekaran" is, to any syntactic rule,
 * indistinguishable from "Personal Details" or "Tamil Nadu".
 *
 * The only thing that knows Ravi Kumar Chandrasekaran is a name is the vault.
 * So the last pass before egress happens *here*, in a module that is allowed to
 * read the vault — and `redaction.ts` stays clean, still unable to import it.
 *
 * ## Why this does not reopen the boundary
 *
 * The boundary's purpose is that user data cannot *accidentally* be sent. This
 * module can only subtract: known values are used as needles for `replace`,
 * never copied into the payload. And it is fail-closed twice over — if a known
 * value somehow survives the scrub, the payload is refused rather than sent,
 * and if the vault is locked there is no denylist to check against, so no call
 * is made at all.
 *
 * ## The branded type
 *
 * `llm-client.ts` accepts only a `GuardedPayload`, which can be produced
 * nowhere but here. Skipping the guard is not a discipline anyone has to
 * remember; it is a type error.
 */

import type { FieldKey } from '@/matching/taxonomy';
import { FIELD_KEYS } from '@/matching/taxonomy';
import type { RedactedField } from './redaction';

declare const guarded: unique symbol;

/** A payload that has been checked against the user's own values. */
export interface GuardedPayload {
  readonly [guarded]: true;
  readonly fields: readonly RedactedField[];
}

export interface GuardOutcome {
  /** Null means: do not call the model. */
  payload: GuardedPayload | null;
  /** How many occurrences of a known value were removed. */
  removed: number;
  /** Set when the payload was refused, with a reason for the log. */
  refused?: string;
}

/**
 * Keys whose values may legitimately appear in page text.
 *
 * These are *categorical*: their values are drawn from a public vocabulary the
 * portal already prints in its own dropdowns. Scrubbing "Karnataka" out of a
 * State select's option list would not protect anybody — the portal offers it
 * to every visitor — and would destroy the option list the model needs to
 * match the field at all.
 *
 * Everything not on this list is scrubbed. A key added to the taxonomy later
 * is therefore protected by default, which is the direction a list like this
 * has to fail in. `value-guard.test.ts` asserts that property directly.
 */
const CATEGORICAL: ReadonlySet<string> = new Set<FieldKey>([
  'identity.gender',
  'identity.category',
  'identity.nationality',
  'identity.marital_status',
  'identity.religion',
  'identity.mother_tongue',
  'address.permanent.state',
  'address.permanent.district',
  'address.permanent.country',
  'address.correspondence.state',
  'address.correspondence.district',
  'address.correspondence.country',
  'bank.account_type',
]);

/** Is this key's value safe to leave in page text? */
export function isCategorical(key: string): boolean {
  return CATEGORICAL.has(key);
}

/**
 * Tokens shorter than this are not scrubbed individually.
 *
 * A multi-word value is scrubbed whole *and* token by token, because a portal
 * may print only the surname. Three characters and under are excluded: too
 * many of them are ordinary words, and scrubbing "Rai" would take the "rai" out
 * of unrelated text without protecting anything a full-value match would miss.
 */
const MIN_TOKEN = 4;

export const REDACTED = '[redacted]';

/**
 * Build the denylist from vault entries.
 *
 * Takes entries rather than reading the vault itself, so the interesting logic
 * stays testable without a database — and so the one place that touches the
 * vault is a single, visible call in `llm-matcher.ts`.
 */
export function denyListFrom(
  entries: ReadonlyArray<{ key: string; value: string }>,
): string[] {
  const needles = new Set<string>();

  for (const entry of entries) {
    const value = entry.value.trim();
    if (value === '' || isCategorical(entry.key)) continue;

    needles.add(value);
    for (const token of value.split(/[\s,./-]+/)) {
      if (token.length >= MIN_TOKEN) needles.add(token);
    }
  }

  // Longest first: scrubbing "Ravi Kumar" before "Kumar" leaves one
  // placeholder rather than "[redacted] [redacted]".
  return [...needles].sort((a, b) => b.length - a.length);
}

/**
 * The last gate before anything is transmitted.
 *
 * Scrubs every known value out of every string in the payload, then checks
 * again. A survivor means a bug here, and the response to a bug in a privacy
 * control is to refuse, not to proceed and hope.
 */
export function guardPayload(
  fields: readonly RedactedField[],
  denyList: readonly string[],
): GuardOutcome {
  let removed = 0;

  const scrub = (text: string): string => {
    let out = text;
    for (const needle of denyList) {
      if (needle === '') continue;
      const pattern = new RegExp(escapeRegExp(needle), 'gi');
      out = out.replace(pattern, () => {
        removed += 1;
        return REDACTED;
      });
    }
    return out;
  };

  const cleaned: RedactedField[] = fields.map((field) => ({
    ...field,
    label: scrub(field.label),
    ...(field.name === undefined ? {} : { name: scrub(field.name) }),
    ...(field.nearby === undefined ? {} : { nearby: scrub(field.nearby) }),
    ...(field.options === undefined ? {} : { options: field.options.map(scrub) }),
  }));

  const survivor = findSurvivor(cleaned, denyList);
  if (survivor !== null) {
    return {
      payload: null,
      removed,
      refused: `A value from your vault survived redaction (${survivor}). Nothing was sent.`,
    };
  }

  // § Phase C: the schema check, at the last moment before a payload exists.
  // Placed here rather than in `redaction.ts` so it guards *everything* that
  // reaches the client, including anything a future caller assembles by hand.
  const schema = checkPayloadSchema(cleaned);
  if (!schema.ok) {
    return {
      payload: null,
      removed,
      refused: `The payload carried a property that is not in the contract ("${schema.offender}"). Nothing was sent.`,
    };
  }

  return { payload: { fields: cleaned } as unknown as GuardedPayload, removed };
}

/**
 * Look for any known value still present.
 *
 * Reports the *kind* of failure, never the value: a refusal message that
 * quoted what leaked would be the leak, written to a log.
 */
function findSurvivor(fields: readonly RedactedField[], denyList: readonly string[]): string | null {
  const haystack = JSON.stringify(fields).toLowerCase();
  for (const needle of denyList) {
    if (needle.length < MIN_TOKEN) continue;
    if (haystack.includes(needle.toLowerCase())) return `a ${needle.length}-character value`;
  }
  return null;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The exact set of properties a transmitted field may carry (§ Phase C).
 *
 *   "Outbound payloads contain only: label text, name/id, type, options,
 *    nearby text, maxLength, pattern. Nothing else. Schema-validate before send."
 *
 * `RedactedField` already makes this true by construction. This is the runtime
 * half, and it exists because "by construction" stops being true the moment
 * somebody spreads a wider object into a narrower type — which TypeScript
 * permits through an `as`, an `any`, or a JSON round-trip.
 */
const ALLOWED_FIELD_KEYS: ReadonlySet<string> = new Set([
  'ref',
  'label',
  'name',
  'type',
  'maxLength',
  'pattern',
  'nearby',
  'options',
  'required',
]);

export interface SchemaCheck {
  ok: boolean;
  /** The offending property name, never its value. */
  offender?: string;
}

/**
 * Does this payload carry only what the contract permits?
 *
 * Checked recursively, because a nested object is exactly how something would
 * arrive unnoticed. Reports the property *name* — a message quoting the value
 * would put the thing we refused to send into a log.
 */
export function checkPayloadSchema(fields: readonly RedactedField[]): SchemaCheck {
  for (const field of fields) {
    for (const [name, value] of Object.entries(field)) {
      if (!ALLOWED_FIELD_KEYS.has(name)) return { ok: false, offender: name };

      // Options are the only array, and it must be plain strings — an array of
      // objects would be a place for anything at all to ride along.
      if (name === 'options') {
        if (!Array.isArray(value)) return { ok: false, offender: 'options' };
        if (value.some((item) => typeof item !== 'string')) {
          return { ok: false, offender: 'options[]' };
        }
        continue;
      }

      if (value !== null && typeof value === 'object') {
        return { ok: false, offender: name };
      }
    }
  }
  return { ok: true };
}

/** Read the payload back out. The only way to reach a guarded payload's body. */
export function payloadFields(payload: GuardedPayload): readonly RedactedField[] {
  return payload.fields;
}

/** Every taxonomy key that is *not* categorical — i.e. gets scrubbed. */
export function protectedKeys(): FieldKey[] {
  return FIELD_KEYS.filter((key) => !isCategorical(key));
}
