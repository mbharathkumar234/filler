/**
 * Field-level validation (§ Phase 1 Should Achieve).
 *
 * These catch typos at data-entry time, which is the cheapest possible moment.
 * A wrong Aadhaar digit discovered here costs a keystroke; discovered after
 * submission it can cost a rejected application.
 *
 * Every validator is pure and total: it returns a result, never throws, and
 * never logs the value it was given.
 */

import type { FieldKey } from '@/matching/taxonomy';

export interface ValidationResult {
  valid: boolean;
  /** Human-readable, safe to show in the UI. Never contains the value itself. */
  message?: string;
}

const OK: ValidationResult = { valid: true };

function fail(message: string): ValidationResult {
  return { valid: false, message };
}

// ---------------------------------------------------------------------------
// Aadhaar — 12 digits with a Verhoeff check digit
// ---------------------------------------------------------------------------

// Verhoeff dihedral group D5 multiplication table.
const VERHOEFF_D = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
  [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
  [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
  [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
  [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
  [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
  [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
  [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
] as const;

// Verhoeff permutation table.
const VERHOEFF_P = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
  [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
  [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
  [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
] as const;

const VERHOEFF_INV = [0, 4, 3, 2, 1, 5, 6, 7, 8, 9] as const;

/** Strip the spaces and hyphens users naturally type into ID fields. */
export function normaliseDigits(value: string): string {
  return value.replace(/[\s-]/g, '');
}

export function verhoeffValid(digits: string): boolean {
  if (!/^\d+$/.test(digits)) return false;
  let c = 0;
  const reversed = [...digits].reverse();
  for (let i = 0; i < reversed.length; i += 1) {
    const digit = Number(reversed[i]);
    c = VERHOEFF_D[c]![VERHOEFF_P[i % 8]![digit]!]!;
  }
  return c === 0;
}

/** Compute the Verhoeff check digit for an 11-digit Aadhaar base. */
export function verhoeffCheckDigit(base: string): number {
  let c = 0;
  const reversed = [...base].reverse();
  for (let i = 0; i < reversed.length; i += 1) {
    const digit = Number(reversed[i]);
    c = VERHOEFF_D[c]![VERHOEFF_P[(i + 1) % 8]![digit]!]!;
  }
  return VERHOEFF_INV[c]!;
}

export function validateAadhaar(value: string): ValidationResult {
  const digits = normaliseDigits(value);
  if (!/^\d{12}$/.test(digits)) return fail('Aadhaar must be exactly 12 digits.');
  // UIDAI never issues a number starting 0 or 1.
  if (digits.startsWith('0') || digits.startsWith('1')) {
    return fail('Aadhaar cannot start with 0 or 1.');
  }
  if (!verhoeffValid(digits)) return fail('Aadhaar checksum failed — check for a typo.');
  return OK;
}

// ---------------------------------------------------------------------------
// PAN, IFSC, PIN
// ---------------------------------------------------------------------------

const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;

/** The 4th character encodes holder type; P = individual is the common case. */
const PAN_HOLDER_TYPES = 'ABCFGHJLPT';

export function validatePan(value: string): ValidationResult {
  const pan = value.trim().toUpperCase();
  if (!PAN_RE.test(pan)) {
    return fail('PAN must look like ABCDE1234F — five letters, four digits, one letter.');
  }
  if (!PAN_HOLDER_TYPES.includes(pan[3]!)) {
    return fail(`PAN's 4th character "${pan[3]}" is not a valid holder type.`);
  }
  return OK;
}

const IFSC_RE = /^[A-Z]{4}0[A-Z0-9]{6}$/;

export function validateIfsc(value: string): ValidationResult {
  const ifsc = value.trim().toUpperCase();
  if (!IFSC_RE.test(ifsc)) {
    return fail('IFSC must be 4 letters, then 0, then 6 characters — e.g. SBIN0001234.');
  }
  return OK;
}

export function validatePincode(value: string): ValidationResult {
  const pin = normaliseDigits(value);
  if (!/^\d{6}$/.test(pin)) return fail('PIN code must be exactly 6 digits.');
  if (pin.startsWith('0')) return fail('PIN code cannot start with 0.');
  return OK;
}

const MOBILE_RE = /^[6-9]\d{9}$/;

export function validateMobile(value: string): ValidationResult {
  const digits = normaliseDigits(value).replace(/^(\+91|91)/, '');
  if (!/^\d{10}$/.test(digits)) return fail('Mobile number must be 10 digits.');
  if (!MOBILE_RE.test(digits)) return fail('Indian mobile numbers start with 6, 7, 8 or 9.');
  return OK;
}

const EMAIL_RE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

export function validateEmail(value: string): ValidationResult {
  if (!EMAIL_RE.test(value.trim())) return fail('That does not look like an email address.');
  return OK;
}

// ---------------------------------------------------------------------------
// Date of birth
// ---------------------------------------------------------------------------

/** Oldest plausible applicant. Beyond this a typo is far likelier than a truth. */
const MAX_AGE_YEARS = 120;

export function validateDob(value: string, now: Date = new Date()): ValidationResult {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return fail('Date of birth must be in YYYY-MM-DD form.');

  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));

  // Round-trip check rejects 2025-02-30 and friends, which Date silently rolls over.
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return fail('That date does not exist.');
  }

  if (date.getTime() > now.getTime()) return fail('Date of birth cannot be in the future.');

  const oldest = new Date(
    Date.UTC(now.getUTCFullYear() - MAX_AGE_YEARS, now.getUTCMonth(), now.getUTCDate()),
  );
  if (date.getTime() < oldest.getTime()) {
    return fail(`Date of birth is more than ${MAX_AGE_YEARS} years ago — check the year.`);
  }

  return OK;
}

// ---------------------------------------------------------------------------
// Dispatch by taxonomy key
// ---------------------------------------------------------------------------

const VALIDATORS: Partial<Record<FieldKey, (value: string) => ValidationResult>> = {
  'id.aadhaar': validateAadhaar,
  'id.pan': validatePan,
  'bank.ifsc': validateIfsc,
  'address.permanent.pincode': validatePincode,
  'address.correspondence.pincode': validatePincode,
  'contact.mobile': validateMobile,
  'contact.alt_mobile': validateMobile,
  'contact.email': validateEmail,
  'identity.dob': (v) => validateDob(v),
};

/**
 * Validate a value for a taxonomy key. Keys with no registered validator are
 * accepted — absence of a rule is not a reason to block the user.
 */
export function validateField(key: FieldKey, value: string): ValidationResult {
  if (value.trim() === '') return OK;
  return VALIDATORS[key]?.(value) ?? OK;
}

export function hasValidator(key: FieldKey): boolean {
  return key in VALIDATORS;
}
