import { describe, expect, it } from 'vitest';
import {
  FIELD_KEYS,
  KEY_ALIASES,
  SENSITIVITY,
  isDocumentKey,
  isFieldKey,
  isRepeatableKey,
  resolveKey,
  sensitivityOf,
  type FieldKey,
} from './taxonomy';

/**
 * These are invariant tests, not behaviour tests. They exist because §4 rule 1
 * ("keys are append-only") and §6.3 (per-key sensitivity) are load-bearing for
 * every later phase, and a silent violation would only surface as a shipped
 * site profile that no longer resolves.
 */
describe('taxonomy invariants', () => {
  it('has no duplicate keys', () => {
    expect(new Set(FIELD_KEYS).size).toBe(FIELD_KEYS.length);
  });

  it('assigns a sensitivity tier to every key', () => {
    const missing = FIELD_KEYS.filter((k) => SENSITIVITY[k] === undefined);
    expect(missing).toEqual([]);
  });

  it('has no sensitivity entries for keys that do not exist', () => {
    const orphans = Object.keys(SENSITIVITY).filter((k) => !isFieldKey(k));
    expect(orphans).toEqual([]);
  });

  it('uses dot-separated lowercase namespaces', () => {
    const malformed = FIELD_KEYS.filter((k) => !/^[a-z]+(\[\])?(\.[a-z0-9_]+(\[\])?)+$/.test(k));
    expect(malformed).toEqual([]);
  });

  it('marks every government id and bank account identifier as high sensitivity', () => {
    const mustBeHigh = FIELD_KEYS.filter(
      (k) => k.startsWith('id.') || k === 'bank.account_number' || k === 'bank.ifsc',
    );
    expect(mustBeHigh.length).toBeGreaterThan(0);
    for (const key of mustBeHigh) {
      expect(sensitivityOf(key), key).toBe('high');
    }
  });

  it('never aliases a key to a target outside the taxonomy', () => {
    for (const [from, to] of Object.entries(KEY_ALIASES)) {
      expect(isFieldKey(to), `${from} -> ${to}`).toBe(true);
      expect(isFieldKey(from), `${from} must be retired, not live`).toBe(false);
    }
  });
});

describe('taxonomy helpers', () => {
  it('recognises document keys', () => {
    expect(isDocumentKey('doc.photo')).toBe(true);
    expect(isDocumentKey('identity.full_name')).toBe(false);
  });

  it('recognises repeatable row keys', () => {
    expect(isRepeatableKey('education[].cgpa')).toBe(true);
    expect(isRepeatableKey('bank.ifsc')).toBe(false);
  });

  it('rejects invented keys', () => {
    expect(isFieldKey('identity.favourite_colour')).toBe(false);
    expect(resolveKey('identity.favourite_colour')).toBeUndefined();
  });

  it('resolves a live key to itself', () => {
    expect(resolveKey('id.pan')).toBe('id.pan' satisfies FieldKey);
  });
});
