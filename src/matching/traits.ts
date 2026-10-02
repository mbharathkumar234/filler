/**
 * Per-key traits, used as **filters** rather than as score contributors (§ Phase 4:
 * "type/maxLength/pattern compatibility as a *filter*").
 *
 * The distinction matters. A signal that merely lowers a score can still be
 * outvoted; a veto cannot. §6.4 rates a high-confidence *mis*-match as Critical
 * — worse than a miss — so the structural facts of a field (it holds 10 digits;
 * it is a date picker) are allowed to rule keys out outright.
 *
 * The plan's own example: "a 10-char numeric field is not identity.full_name".
 */

import { FIELD_KEYS, type FieldKey } from './taxonomy';
import type { FieldDescriptor } from '@/shared/types';

export type ValueShape = 'text' | 'numeric' | 'alphanumeric' | 'date' | 'email' | 'phone' | 'file' | 'choice';

export interface FieldTraits {
  shape: ValueShape;
  /** Shortest sensible value. A field capped below this cannot hold the key. */
  minLength?: number;
  /** Longest sensible value, used to reject absurdly long inputs for short keys. */
  maxLength?: number;
  /** Exact character count, when the key has one (Aadhaar 12, PAN 10, IFSC 11). */
  exactLength?: number;
}

/** Keys with no entry accept anything — absence of a rule is not a veto. */
export const TRAITS: Partial<Record<FieldKey, FieldTraits>> = {
  'identity.full_name': { shape: 'text', minLength: 3, maxLength: 100 },
  'identity.given_name': { shape: 'text', minLength: 2, maxLength: 60 },
  'identity.middle_name': { shape: 'text', minLength: 1, maxLength: 60 },
  'identity.surname': { shape: 'text', minLength: 1, maxLength: 60 },
  'identity.dob': { shape: 'date' },
  'identity.gender': { shape: 'choice' },
  'identity.category': { shape: 'choice' },
  'identity.nationality': { shape: 'text', maxLength: 60 },
  'identity.marital_status': { shape: 'choice' },
  'identity.religion': { shape: 'choice' },
  'identity.mother_tongue': { shape: 'text', maxLength: 40 },
  'identity.blood_group': { shape: 'choice' },

  'family.father_name': { shape: 'text', minLength: 3, maxLength: 100 },
  'family.mother_name': { shape: 'text', minLength: 3, maxLength: 100 },
  'family.guardian_name': { shape: 'text', minLength: 3, maxLength: 100 },
  'family.father_occupation': { shape: 'text', maxLength: 60 },
  'family.annual_income': { shape: 'numeric', maxLength: 12 },
  'family.father_mobile': { shape: 'phone', exactLength: 10 },
  'family.mother_mobile': { shape: 'phone', exactLength: 10 },
  'family.guardian_mobile': { shape: 'phone', exactLength: 10 },
  'family.father_email': { shape: 'email', minLength: 6 },
  'family.mother_email': { shape: 'email', minLength: 6 },
  'family.guardian_email': { shape: 'email', minLength: 6 },

  'contact.email': { shape: 'email', minLength: 6 },
  'contact.mobile': { shape: 'phone', exactLength: 10 },
  'contact.alt_mobile': { shape: 'phone', exactLength: 10 },
  'contact.landline': { shape: 'phone', minLength: 6, maxLength: 15 },
  'contact.alt_email': { shape: 'email', minLength: 6 },
  'contact.official_email': { shape: 'email', minLength: 6 },

  'address.permanent.line1': { shape: 'text', minLength: 3, maxLength: 200 },
  'address.permanent.line2': { shape: 'text', maxLength: 200 },
  'address.permanent.city': { shape: 'text', minLength: 2, maxLength: 60 },
  'address.permanent.district': { shape: 'text', minLength: 2, maxLength: 60 },
  'address.permanent.state': { shape: 'choice' },
  'address.permanent.pincode': { shape: 'numeric', exactLength: 6 },
  'address.permanent.country': { shape: 'choice' },

  'address.correspondence.line1': { shape: 'text', minLength: 3, maxLength: 200 },
  'address.correspondence.line2': { shape: 'text', maxLength: 200 },
  'address.correspondence.city': { shape: 'text', minLength: 2, maxLength: 60 },
  'address.correspondence.district': { shape: 'text', minLength: 2, maxLength: 60 },
  'address.correspondence.state': { shape: 'choice' },
  'address.correspondence.pincode': { shape: 'numeric', exactLength: 6 },
  'address.correspondence.country': { shape: 'choice' },

  'id.aadhaar': { shape: 'numeric', exactLength: 12 },
  'id.pan': { shape: 'alphanumeric', exactLength: 10 },
  'id.passport': { shape: 'alphanumeric', minLength: 8, maxLength: 12 },
  'id.voter': { shape: 'alphanumeric', minLength: 10, maxLength: 12 },
  'id.driving_licence': { shape: 'alphanumeric', minLength: 9, maxLength: 20 },
  'id.abc_id': { shape: 'numeric', minLength: 8, maxLength: 14 },
  'id.apaar': { shape: 'numeric', minLength: 8, maxLength: 14 },

  'education[].level': { shape: 'choice' },
  'education[].board_or_university': { shape: 'text', minLength: 2, maxLength: 100 },
  'education[].institution': { shape: 'text', minLength: 2, maxLength: 120 },
  'education[].roll_number': { shape: 'alphanumeric', minLength: 2, maxLength: 25 },
  'education[].year_of_passing': { shape: 'numeric', exactLength: 4 },
  'education[].marks_obtained': { shape: 'numeric', maxLength: 6 },
  'education[].max_marks': { shape: 'numeric', maxLength: 6 },
  'education[].percentage': { shape: 'numeric', maxLength: 6 },
  'education[].cgpa': { shape: 'numeric', maxLength: 5 },

  'bank.account_holder': { shape: 'text', minLength: 3, maxLength: 100 },
  'bank.account_number': { shape: 'numeric', minLength: 9, maxLength: 18 },
  'bank.ifsc': { shape: 'alphanumeric', exactLength: 11 },
  'bank.bank_name': { shape: 'text', minLength: 2, maxLength: 80 },
  'bank.branch': { shape: 'text', minLength: 2, maxLength: 80 },
  'bank.account_type': { shape: 'choice' },

  /*
   * A semester and a year of study have no entry on purpose.
   *
   * They are one or two characters — "7", "IV", "4th" — and the general rule
   * below vetoes any key for a field capped under three, on the reasoning that
   * no value is meaningful in two characters. These two are, so the rule that
   * would rule them out is the rule they must not be subject to: absence of an
   * entry is not a veto (see the note above this table).
   */

  // The entrance exam, as numbers. A score may be a percentile with a decimal
  // point, so it is left unconstrained rather than forced to be whole.
  'entrance.exam_name': { shape: 'text', maxLength: 60 },
  'entrance.registration_number': { shape: 'alphanumeric', minLength: 4, maxLength: 30 },
  'entrance.roll_number': { shape: 'alphanumeric', minLength: 4, maxLength: 30 },
  'entrance.rank': { shape: 'numeric', maxLength: 8 },
  'entrance.year': { shape: 'numeric', exactLength: 4 },

  // Karnataka's RD numbers: the acknowledgement printed on a Nadakacheri
  // certificate, letters and digits together (e.g. "RD0123456789012").
  'eligibility.caste_certificate_number': { shape: 'alphanumeric', minLength: 6, maxLength: 30 },
  'eligibility.income_certificate_number': { shape: 'alphanumeric', minLength: 6, maxLength: 30 },
  'eligibility.article_371j_number': { shape: 'alphanumeric', minLength: 6, maxLength: 30 },
};

for (const key of FIELD_KEYS) {
  if (key.startsWith('doc.')) {
    TRAITS[key] = { shape: 'file' };
  }
}

// ---------------------------------------------------------------------------
// What the field itself will accept
// ---------------------------------------------------------------------------

export interface FieldCapability {
  shape: ValueShape | 'unknown';
  maxLength?: number;
  /** True when the control's own pattern/type restricts it to digits. */
  numericOnly: boolean;
}

const NUMERIC_PATTERN = /^\W*\[?0-9|^\W*\\d|^\[0-9\]/;

export function capabilityOf(field: FieldDescriptor): FieldCapability {
  const type = (field.type ?? '').toLowerCase();

  let shape: ValueShape | 'unknown' = 'unknown';
  if (field.tag === 'file') shape = 'file';
  else if (field.tag === 'select' || field.tag === 'radio-group') shape = 'choice';
  else if (type === 'date' || type === 'month') shape = 'date';
  else if (type === 'email') shape = 'email';
  else if (type === 'tel') shape = 'phone';
  else if (type === 'number') shape = 'numeric';

  const inputmode = (field.inputmode ?? '').toLowerCase();
  const numericOnly =
    type === 'number' ||
    inputmode === 'numeric' ||
    inputmode === 'tel' ||
    (field.pattern !== undefined && NUMERIC_PATTERN.test(field.pattern)) ||
    (field.pattern !== undefined && /^\[0-9\][{+*]/.test(field.pattern));

  // A field that declares itself numeric *is* numeric, whatever its label
  // claims. This is the plan's own worked example, reached through the
  // attribute portals actually use rather than only through `type="number"`.
  if (shape === 'unknown' && numericOnly) shape = 'numeric';

  const capability: FieldCapability = { shape, numericOnly };
  if (field.maxLength !== undefined) capability.maxLength = field.maxLength;
  return capability;
}

// ---------------------------------------------------------------------------
// The veto
// ---------------------------------------------------------------------------

export interface VetoResult {
  vetoed: boolean;
  reason?: string;
}

const COMPATIBLE: Record<ValueShape, ValueShape[]> = {
  text: ['text', 'alphanumeric'],
  numeric: ['numeric', 'text', 'alphanumeric', 'phone'],
  alphanumeric: ['alphanumeric', 'text', 'numeric'],
  date: ['date', 'text'],
  email: ['email', 'text'],
  phone: ['phone', 'numeric', 'text'],
  file: ['file'],
  choice: ['choice', 'text'],
};

/**
 * Can this field hold this key's value?
 *
 * Returns a veto with a reason, so the review screen can explain a *miss*
 * ("this box only takes 10 characters") rather than leaving the user to wonder.
 */
/**
 * Value shapes a *label* can state outright, and the tokens that state them.
 *
 * A label is normally evidence about *which* key a field is. These tokens are
 * stronger than that: they say what kind of value the box holds, whatever else
 * the label contains. "Email ID (Official /college Email address)" is an email
 * box. The word "college" in it is a qualifier — it narrows which email — and
 * it cannot turn the field into a college name.
 *
 * Deliberately only two entries. Both are unambiguous in every form of English
 * a portal uses, and both name a value shape no other key shares. Adding
 * "date" or "name" here would be a guess about a word that genuinely appears
 * in unrelated labels ("Name of Bank", "Date of Issue").
 */
const LABEL_SHAPES: ReadonlyArray<{ pattern: RegExp; shape: ValueShape }> = [
  { pattern: /\be-?\s?mail\b/i, shape: 'email' },
  { pattern: /\b(mobile|phone|whatsapp)\b/i, shape: 'phone' },
];

/** The shape a label declares outright, if any. */
export function declaredShape(field: FieldDescriptor): ValueShape | null {
  const label = `${field.labelText} ${field.placeholder ?? ''}`;
  for (const { pattern, shape } of LABEL_SHAPES) {
    if (pattern.test(label)) return shape;
  }
  return null;
}

/** Shapes that can legitimately answer a label declaring `declared`. */
const SATISFIES: Readonly<Record<string, readonly ValueShape[]>> = {
  email: ['email'],
  phone: ['phone', 'numeric'],
};

export function veto(field: FieldDescriptor, key: FieldKey): VetoResult {
  const capability = capabilityOf(field);

  /*
   * A file input holds a document and nothing else, in either direction.
   *
   * Decided by the key's family, before looking its traits up. It used to sit
   * below the lookup, and a key with no traits entry skipped every check —
   * which is what composed keys are: "Upload your 10th marks card" composed
   * `education.class_10.marks_obtained`, and a file box was mapped to a marks
   * box. The rule never depended on a key's traits, so it no longer waits for
   * them.
   */
  const documentKey = key.startsWith('doc.');
  if (capability.shape === 'file' && !documentKey) {
    return { vetoed: true, reason: 'this is a file upload, not a text field' };
  }
  if (documentKey && capability.shape !== 'file') {
    return { vetoed: true, reason: 'this key is a document, and the field is not a file input' };
  }

  const traits = TRAITS[key];
  if (!traits) return { vetoed: false };

  /*
   * A label that names its own value shape rules out every key of another.
   *
   * This exists because of a real mis-fill. On a form with two email
   * questions, `matchForm` gave the first one `contact.email`, then re-matched
   * the second with that key excluded — and the fallback, unguarded, picked
   * `education[].institution` at 0.82 off the word "college". A university's
   * name was typed into a box labelled "Email ID (Official /college Email
   * address)".
   *
   * The de-duplication itself is right: two fields claiming one key is a
   * mis-match waiting to happen. What was missing is that its *second* choice
   * has to remain the same kind of thing as its first. With no email key left
   * to give, the honest answer is no answer — the field is left blank and the
   * user fills it, which §6.4 ranks far above a confident wrong value.
   */
  const declared = declaredShape(field);
  if (declared !== null && !SATISFIES[declared]!.includes(traits.shape)) {
    return {
      vetoed: true,
      reason: `the label says this box holds ${declared === 'email' ? 'an email address' : 'a phone number'}, and this key does not`,
    };
  }

  // A select/radio holds one of a fixed set. A free-text key such as a name or
  // an address line cannot be one of those.
  if (capability.shape === 'choice' && !['choice', 'text'].includes(traits.shape)) {
    return { vetoed: true, reason: 'this is a fixed set of options, not a free-text value' };
  }

  if (
    capability.shape !== 'unknown' &&
    capability.shape !== 'choice' &&
    !COMPATIBLE[traits.shape].includes(capability.shape)
  ) {
    return {
      vetoed: true,
      reason: `field accepts ${capability.shape} values and this key is ${traits.shape}`,
    };
  }

  // The plan's worked example: a 10-character box is not a full name.
  if (capability.maxLength !== undefined) {
    if (traits.minLength !== undefined && capability.maxLength < traits.minLength) {
      return {
        vetoed: true,
        reason: `field caps at ${capability.maxLength} characters, too short for this key`,
      };
    }
    if (traits.exactLength !== undefined && capability.maxLength < traits.exactLength) {
      return {
        vetoed: true,
        reason: `field caps at ${capability.maxLength} characters and this key needs ${traits.exactLength}`,
      };
    }
    // A generously-capped field is not evidence against a short key, but a
    // *tightly* capped one is evidence against a long key.
    if (traits.maxLength !== undefined && capability.maxLength < Math.min(3, traits.maxLength)) {
      return { vetoed: true, reason: 'field is too short for any meaningful value' };
    }
  }

  // A digits-only control cannot hold a name or an address.
  if (capability.numericOnly && ['text', 'email'].includes(traits.shape)) {
    return { vetoed: true, reason: 'field accepts digits only' };
  }

  return { vetoed: false };
}

/** Keys that survive the veto for this field. */
export function allowedKeys(field: FieldDescriptor, keys: readonly FieldKey[]): FieldKey[] {
  return keys.filter((key) => !veto(field, key).vetoed);
}
