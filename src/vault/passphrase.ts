/**
 * Passphrase strength (§ Phase 1 Should Achieve: "refuse anything under a
 * reasonable floor").
 *
 * The threat model is explicit that this is the weakest link in the design: a
 * short passphrase falls to an offline GPU attack no matter how many PBKDF2
 * iterations sit behind it. So this module is allowed to say no.
 *
 * The estimate is deliberately conservative — a rough character-class entropy
 * with penalties for the patterns crackers try first. It is not a substitute
 * for zxcvbn; it is a floor that catches "password1" and "aaaaaaaa".
 */

export type StrengthLabel = 'unusable' | 'weak' | 'fair' | 'strong' | 'excellent';

export interface PassphraseStrength {
  /** Estimated bits of entropy, after penalties. */
  bits: number;
  label: StrengthLabel;
  /** False means vault creation must be refused. */
  acceptable: boolean;
  /** Short, actionable, safe to render. Never contains the passphrase. */
  feedback: string[];
}

/** Below this a vault cannot be created. */
export const MINIMUM_BITS = 50;

/** Below this length we refuse regardless of character variety. */
export const MINIMUM_LENGTH = 12;

const COMMON_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/^[0-9]+$/, 'Digits alone are guessed almost instantly.'],
  [/^[a-z]+$/, 'All-lowercase phrases are the first thing an attacker tries.'],
  [/(.)\1{3,}/, 'Avoid repeating the same character.'],
  [/^(?:012|123|234|345|456|567|678|789|890|abc|qwe|asd|zxc)/i, 'Avoid keyboard runs.'],
  [/pass|password|admin|welcome|letmein|secret|aadhaar|autofill/i, 'Avoid predictable words.'],
];

function charsetSize(value: string): number {
  let size = 0;
  if (/[a-z]/.test(value)) size += 26;
  if (/[A-Z]/.test(value)) size += 26;
  if (/[0-9]/.test(value)) size += 10;
  if (/[^A-Za-z0-9]/.test(value)) size += 33;
  return size;
}

/** Distinct characters, so "aaaaaaaaaaaa" does not score as twelve characters. */
function effectiveLength(value: string): number {
  const distinct = new Set(value).size;
  return Math.min(value.length, distinct + (value.length - distinct) * 0.35);
}

export function estimateStrength(passphrase: string): PassphraseStrength {
  const feedback: string[] = [];

  if (passphrase.length === 0) {
    return { bits: 0, label: 'unusable', acceptable: false, feedback: ['Enter a passphrase.'] };
  }

  const size = charsetSize(passphrase);
  let bits = effectiveLength(passphrase) * Math.log2(Math.max(size, 2));

  for (const [pattern, note] of COMMON_PATTERNS) {
    if (pattern.test(passphrase)) {
      bits *= 0.6;
      feedback.push(note);
    }
  }

  bits = Math.round(bits);

  if (passphrase.length < MINIMUM_LENGTH) {
    feedback.unshift(`Use at least ${MINIMUM_LENGTH} characters — longer beats more complex.`);
  }

  const label = labelFor(bits);
  const acceptable = bits >= MINIMUM_BITS && passphrase.length >= MINIMUM_LENGTH;

  if (acceptable && feedback.length === 0) {
    feedback.push('Good. Store it somewhere safe — it cannot be recovered.');
  } else if (!acceptable && feedback.length === 0) {
    feedback.push('Add more length, or mix in another character type.');
  }

  return { bits, label, acceptable, feedback };
}

function labelFor(bits: number): StrengthLabel {
  if (bits < 28) return 'unusable';
  if (bits < MINIMUM_BITS) return 'weak';
  if (bits < 70) return 'fair';
  if (bits < 100) return 'strong';
  return 'excellent';
}
