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
};

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
    id: 'education',
    title: 'Education',
    hint: 'Repeatable rows arrive with the review screen; one set for now.',
    keys: keysWithPrefix('education['),
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
