import { describe, expect, it } from 'vitest';

import { describeReauth, reauthCheck, REAUTH_IDLE_MS } from './reauth';
import { IDLE_LOCK_MS } from '@/vault/session';
import { FIELD_KEYS, SENSITIVITY, type FieldKey } from '@/matching/taxonomy';

const NOW = 1_700_000_000_000;

describe('when the gate fires', () => {
  it('never for ordinary fields, however long the desk has been empty', () => {
    const decision = reauthCheck(
      ['identity.full_name', 'address.permanent.city', 'contact.email'],
      NOW - 10 * 60 * 60 * 1000,
      NOW,
    );
    expect(decision.required).toBe(false);
    expect(decision.keys).toEqual([]);
  });

  it('for a high-sensitivity key once the window has passed', () => {
    const decision = reauthCheck(
      ['identity.full_name', 'id.aadhaar'],
      NOW - REAUTH_IDLE_MS - 1,
      NOW,
    );
    expect(decision.required).toBe(true);
    expect(decision.keys).toEqual(['id.aadhaar']);
  });

  it('not while the passphrase entry is still fresh', () => {
    const decision = reauthCheck(['id.pan'], NOW - REAUTH_IDLE_MS + 1_000, NOW);
    expect(decision.required).toBe(false);
  });

  it('at the boundary, it fires — the window is inclusive of its own end', () => {
    expect(reauthCheck(['id.pan'], NOW - REAUTH_IDLE_MS, NOW).required).toBe(true);
  });

  it('fails closed when nobody has authenticated at all', () => {
    const decision = reauthCheck(['bank.account_number'], null, NOW);
    expect(decision.required).toBe(true);
    expect(decision.idleMs).toBe(Number.POSITIVE_INFINITY);
  });

  it('lists each triggering key once, in the fill order', () => {
    const decision = reauthCheck(
      ['id.aadhaar', 'identity.full_name', 'bank.ifsc', 'id.aadhaar'],
      null,
      NOW,
    );
    expect(decision.keys).toEqual(['id.aadhaar', 'bank.ifsc']);
  });

  it('covers the three the plan names by hand', () => {
    for (const key of ['id.aadhaar', 'id.pan', 'bank.account_number'] as FieldKey[]) {
      expect(SENSITIVITY[key]).toBe('high');
      expect(reauthCheck([key], null, NOW).required).toBe(true);
    }
  });

  it('covers every key the taxonomy calls high, not just the named three', () => {
    const high = FIELD_KEYS.filter((key) => SENSITIVITY[key] === 'high');
    expect(high.length).toBeGreaterThan(3);
    for (const key of high) {
      expect(reauthCheck([key], NOW - REAUTH_IDLE_MS - 1, NOW).required).toBe(true);
    }
  });
});

describe('the window sits inside the auto-lock window', () => {
  it('is shorter than auto-lock, or the gate is dead code', () => {
    // If someone raises REAUTH_IDLE_MS past IDLE_LOCK_MS, the vault always
    // locks first and this gate never fires once. That would look like a
    // working control and be nothing at all.
    expect(REAUTH_IDLE_MS).toBeLessThan(IDLE_LOCK_MS);
  });
});

describe('what the user is told', () => {
  it('names the field, so the prompt is not a reflex', () => {
    expect(describeReauth(['id.aadhaar'])).toBe('Enter your passphrase to fill aadhaar.');
  });

  it('lists several readably', () => {
    expect(describeReauth(['id.aadhaar', 'id.pan', 'bank.account_number'])).toBe(
      'Enter your passphrase to fill aadhaar, pan and account number.',
    );
  });
});
