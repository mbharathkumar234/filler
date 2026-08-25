/**
 * The canonical field taxonomy (§4 of IMPLEMENTATION_PLAN.md).
 *
 * Everything keys off this namespace: the vault schema, matcher output, site
 * profiles, the LLM's closed vocabulary, and the review screen.
 *
 * HARD RULES
 *  1. Keys are APPEND-ONLY. Renaming a key breaks every shipped site profile.
 *     To rename, add the new key and register the old one in `KEY_ALIASES`.
 *  2. Every key carries a sensitivity tier (§6.3). `high` keys require
 *     re-authentication before fill (Phase 6) and are never auto-filled from an
 *     LLM-only match (Phase 8).
 *  3. The LLM may only return a key from this list, plus the literal `'unknown'`.
 */

export const FIELD_KEYS = [
  // identity
  'identity.full_name',
  'identity.given_name',
  'identity.middle_name',
  'identity.surname',
  'identity.dob',
  'identity.gender',
  'identity.category',
  'identity.nationality',
  'identity.marital_status',
  'identity.religion',
  'identity.mother_tongue',
  'identity.blood_group',

  // family
  'family.father_name',
  'family.mother_name',
  'family.guardian_name',
  'family.father_occupation',
  'family.annual_income',

  // contact
  'contact.email',
  'contact.mobile',
  'contact.alt_mobile',
  'contact.landline',

  // address — permanent
  'address.permanent.line1',
  'address.permanent.line2',
  'address.permanent.city',
  'address.permanent.district',
  'address.permanent.state',
  'address.permanent.pincode',
  'address.permanent.country',

  // address — correspondence (same shape as permanent)
  'address.correspondence.line1',
  'address.correspondence.line2',
  'address.correspondence.city',
  'address.correspondence.district',
  'address.correspondence.state',
  'address.correspondence.pincode',
  'address.correspondence.country',

  // government ids (HIGH SENSITIVITY — see §6.3)
  'id.aadhaar',
  'id.pan',
  'id.passport',
  'id.voter',
  'id.driving_licence',
  'id.abc_id',
  'id.apaar',

  // education (repeatable rows)
  'education[].level',
  'education[].board_or_university',
  'education[].institution',
  'education[].roll_number',
  'education[].year_of_passing',
  'education[].marks_obtained',
  'education[].max_marks',
  'education[].percentage',
  'education[].cgpa',

  // banking
  'bank.account_holder',
  'bank.account_number',
  'bank.ifsc',
  'bank.bank_name',
  'bank.branch',
  'bank.account_type',

  // documents
  'doc.photo',
  'doc.signature',
  'doc.aadhaar_card',
  'doc.pan_card',
  'doc.marksheet_10',
  'doc.marksheet_12',
  'doc.degree_certificate',
  'doc.income_certificate',
  'doc.caste_certificate',
  'doc.domicile_certificate',
  'doc.bank_passbook',
  'doc.disability_certificate',
] as const;

export type FieldKey = (typeof FIELD_KEYS)[number];

/** The only value the matcher may return that is not a `FieldKey`. */
export const UNKNOWN_KEY = 'unknown' as const;
export type UnknownKey = typeof UNKNOWN_KEY;

export type Sensitivity = 'low' | 'medium' | 'high';

/**
 * Per-key sensitivity (§6.3).
 *
 *   high   — re-auth before fill; never auto-filled from an LLM-only match;
 *            masked in the review UI until revealed; excluded from any log by default.
 *   medium — normal fill; shown in review.
 *   low    — normal fill.
 *
 * Every key in FIELD_KEYS must appear here; `taxonomy.test.ts` enforces that.
 */
export const SENSITIVITY: Readonly<Record<FieldKey, Sensitivity>> = {
  // identity
  'identity.full_name': 'low',
  'identity.given_name': 'low',
  'identity.middle_name': 'low',
  'identity.surname': 'low',
  'identity.dob': 'medium',
  'identity.gender': 'low',
  'identity.category': 'medium',
  'identity.nationality': 'low',
  'identity.marital_status': 'medium',
  'identity.religion': 'medium',
  'identity.mother_tongue': 'low',
  'identity.blood_group': 'medium',

  // family
  'family.father_name': 'low',
  'family.mother_name': 'low',
  'family.guardian_name': 'low',
  'family.father_occupation': 'medium',
  'family.annual_income': 'medium',

  // contact
  'contact.email': 'medium',
  'contact.mobile': 'medium',
  'contact.alt_mobile': 'medium',
  'contact.landline': 'medium',

  // address — permanent
  'address.permanent.line1': 'medium',
  'address.permanent.line2': 'medium',
  'address.permanent.city': 'medium',
  'address.permanent.district': 'medium',
  'address.permanent.state': 'low',
  'address.permanent.pincode': 'medium',
  'address.permanent.country': 'low',

  // address — correspondence
  'address.correspondence.line1': 'medium',
  'address.correspondence.line2': 'medium',
  'address.correspondence.city': 'medium',
  'address.correspondence.district': 'medium',
  'address.correspondence.state': 'low',
  'address.correspondence.pincode': 'medium',
  'address.correspondence.country': 'low',

  // government ids — all high by rule
  'id.aadhaar': 'high',
  'id.pan': 'high',
  'id.passport': 'high',
  'id.voter': 'high',
  'id.driving_licence': 'high',
  'id.abc_id': 'high',
  'id.apaar': 'high',

  // education
  'education[].level': 'low',
  'education[].board_or_university': 'low',
  'education[].institution': 'low',
  'education[].roll_number': 'medium',
  'education[].year_of_passing': 'medium',
  'education[].marks_obtained': 'medium',
  'education[].max_marks': 'medium',
  'education[].percentage': 'medium',
  'education[].cgpa': 'medium',

  // banking — account identifiers are high
  'bank.account_holder': 'medium',
  'bank.account_number': 'high',
  'bank.ifsc': 'high',
  'bank.bank_name': 'medium',
  'bank.branch': 'medium',
  'bank.account_type': 'low',

  // documents — the bytes are the payload; treat identity documents as high
  'doc.photo': 'medium',
  'doc.signature': 'high',
  'doc.aadhaar_card': 'high',
  'doc.pan_card': 'high',
  'doc.marksheet_10': 'medium',
  'doc.marksheet_12': 'medium',
  'doc.degree_certificate': 'medium',
  'doc.income_certificate': 'high',
  'doc.caste_certificate': 'high',
  'doc.domicile_certificate': 'medium',
  'doc.bank_passbook': 'high',
  'doc.disability_certificate': 'high',
};

/**
 * Retired key -> current key. Populated only when a key is superseded; rule 1
 * above means we never delete or rename an entry in FIELD_KEYS.
 */
export const KEY_ALIASES: Readonly<Record<string, FieldKey>> = {};

/** Keys whose value is a document blob rather than a string. */
export const DOCUMENT_KEY_PREFIX = 'doc.';

/** Keys that belong to a repeatable row group (e.g. one per qualification). */
export const REPEATABLE_MARKER = '[]';

const FIELD_KEY_SET: ReadonlySet<string> = new Set<string>(FIELD_KEYS);

export function isFieldKey(value: string): value is FieldKey {
  return FIELD_KEY_SET.has(value);
}

export function isDocumentKey(key: FieldKey): boolean {
  return key.startsWith(DOCUMENT_KEY_PREFIX);
}

export function isRepeatableKey(key: FieldKey): boolean {
  return key.includes(REPEATABLE_MARKER);
}

export function sensitivityOf(key: FieldKey): Sensitivity {
  return SENSITIVITY[key];
}

/** Resolve a possibly-retired key to its current form, or `undefined`. */
export function resolveKey(value: string): FieldKey | undefined {
  if (isFieldKey(value)) return value;
  return KEY_ALIASES[value];
}
