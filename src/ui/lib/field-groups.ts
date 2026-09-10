/**
 * Presentation grouping for the taxonomy.
 *
 * The taxonomy itself is a flat, stable namespace on purpose (§4). This module
 * is the one place that decides how those keys are grouped and labelled for a
 * human — keeping it out of `taxonomy.ts` means a UI relabel can never look
 * like a taxonomy change to a shipped site profile.
 */

import { FIELD_KEYS, type FieldKey } from '@/matching/taxonomy';

export interface FieldGroup {
  id: string;
  title: string;
  /** Shown under the title when the grouping needs explaining. */
  hint?: string;
  keys: FieldKey[];
}

/** Human label for a key, derived from its last segment unless overridden. */
const LABELS: Partial<Record<FieldKey, string>> = {
  'identity.dob': 'Date of birth (YYYY-MM-DD)',
  'identity.category': 'Category (General / OBC / SC / ST)',
  'id.pan': 'PAN',
  'id.abc_id': 'ABC ID',
  'id.apaar': 'APAAR ID',
  'bank.ifsc': 'IFSC code',
  'contact.alt_mobile': 'Alternate mobile',
  'address.permanent.line1': 'Address line 1',
  'address.permanent.line2': 'Address line 2',
  'address.correspondence.line1': 'Address line 1',
  'address.correspondence.line2': 'Address line 2',
  'address.permanent.pincode': 'PIN code',
  'address.correspondence.pincode': 'PIN code',

  // Layer 3. Abbreviations that must not be title-cased into nonsense
  // ("Obc ncl", "Pwbd", "Udid") — these are how the forms themselves write them.
  'eligibility.caste': 'Caste',
  'eligibility.subcategory': 'Sub-category',
  'eligibility.obc_ncl': 'OBC (non-creamy layer)',
  'eligibility.ews': 'EWS',
  'eligibility.pwbd': 'Person with benchmark disability (PwBD)',
  'eligibility.disability_type': 'Type of disability',
  'eligibility.disability_percentage': 'Disability percentage',
  'eligibility.udid': 'UDID number',
  'eligibility.domicile_state': 'Domicile state',
  'eligibility.local_status': 'Local / non-local status',
  'eligibility.minority': 'Minority community',
  'eligibility.defence_ward': 'Ward of defence personnel',
  'eligibility.ex_serviceman': 'Ex-serviceman',
  'eligibility.sports_quota': 'Sports quota',
  'eligibility.ncc': 'NCC',
  'eligibility.nss': 'NSS',
  'eligibility.orphan': 'Orphan',
  'eligibility.age_relaxation': 'Age relaxation claimed',

  'emergency.name': 'Contact name',
  'emergency.relation': 'Relationship to you',
  'emergency.mobile': 'Contact mobile',

  'family.father_mobile': "Father's mobile",
  'family.mother_mobile': "Mother's mobile",
  'family.guardian_mobile': "Guardian's mobile",
  'family.father_email': "Father's email",
  'family.mother_email': "Mother's email",
  'family.guardian_email': "Guardian's email",
  'contact.alt_email': 'Alternate email',
  'contact.official_email': 'Official / college email',
};

/**
 * The seven qualification blocks (Layer 2), in the order a person earns them.
 *
 * Each holds the same fifteen fields, and the field segment is shared with the
 * generic `education[]` block so that a level named in a label can retarget a
 * generic match onto the right block — see `applyEducationLevel`.
 */
export const QUALIFICATION_LEVELS: ReadonlyArray<{ id: string; prefix: string; title: string }> = [
  { id: 'edu-class-10', prefix: 'education.class_10.', title: 'Class 10 (SSLC / Matriculation)' },
  { id: 'edu-class-12', prefix: 'education.class_12.', title: 'Class 12 (HSC / Intermediate / PUC)' },
  { id: 'edu-diploma', prefix: 'education.diploma.', title: 'Diploma / Polytechnic' },
  { id: 'edu-ug', prefix: 'education.undergraduate.', title: 'Undergraduate degree' },
  { id: 'edu-pg', prefix: 'education.postgraduate.', title: 'Postgraduate degree' },
  { id: 'edu-professional', prefix: 'education.professional_degree.', title: 'Professional degree' },
  { id: 'edu-phd', prefix: 'education.phd.', title: 'Doctorate / PhD' },
];

export function labelFor(key: FieldKey): string {
  const override = LABELS[key];
  if (override) return override;
  const last = key.split('.').pop() ?? key;
  const words = last.replace(/\[\]/g, '').replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function keysWithPrefix(prefix: string): FieldKey[] {
  return FIELD_KEYS.filter((k) => k.startsWith(prefix));
}

export const FIELD_GROUPS: FieldGroup[] = [
  { id: 'identity', title: 'Identity', keys: keysWithPrefix('identity.') },
  { id: 'family', title: 'Family', keys: keysWithPrefix('family.') },
  { id: 'contact', title: 'Contact', keys: keysWithPrefix('contact.') },
  {
    id: 'address-permanent',
    title: 'Permanent address',
    keys: keysWithPrefix('address.permanent.'),
  },
  {
    id: 'address-correspondence',
    title: 'Correspondence address',
    hint: 'Leave blank if it is the same as your permanent address.',
    keys: keysWithPrefix('address.correspondence.'),
  },
  {
    id: 'ids',
    title: 'Government IDs',
    hint: 'High sensitivity: masked here, and never filled from a guess.',
    keys: keysWithPrefix('id.'),
  },
  {
    id: 'emergency',
    title: 'Emergency contact',
    keys: keysWithPrefix('emergency.'),
  },
  {
    id: 'education',
    title: 'Education (any qualification)',
    hint:
      'Used when a form asks for marks or a roll number without saying which ' +
      'qualification. Fill the specific blocks below as well.',
    keys: keysWithPrefix('education['),
  },
  ...QUALIFICATION_LEVELS.map((level) => ({
    id: level.id,
    title: level.title,
    keys: keysWithPrefix(level.prefix),
  })),
  {
    id: 'eligibility',
    title: 'Eligibility and reservation',
    hint:
      'Only fill what applies to you. Your broad category lives under Identity; ' +
      'these narrow it for forms that ask.',
    keys: keysWithPrefix('eligibility.'),
  },
  { id: 'bank', title: 'Bank account', keys: keysWithPrefix('bank.') },
];

/** Document keys are Phase 2; listed so the editor can say so rather than hide them. */
export const DOCUMENT_KEYS: FieldKey[] = keysWithPrefix('doc.');

/** Input type hint for a key, so the browser offers the right keyboard. */
export function inputTypeFor(key: FieldKey): 'text' | 'email' | 'tel' | 'date' | 'number' {
  if (key === 'identity.dob') return 'date';
  if (key === 'contact.email') return 'email';
  if (key.includes('mobile') || key === 'contact.landline') return 'tel';
  if (key.includes('pincode') || key.includes('year_of_passing')) return 'text';
  return 'text';
}
