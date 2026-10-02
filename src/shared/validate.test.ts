import { describe, expect, it } from 'vitest';

import { knownTypes, LIMITS, NO_PAYLOAD_TYPES, validateRequest } from './validate';
import { PRIVILEGED_TYPES } from './messages';

/**
 * Message-bus schema validation (§ Phase 10).
 *
 * The realistic attacker here is a **compromised content script**: it runs in
 * a hostile page's tab, it is a legitimate sender, and the sender check
 * therefore says yes to everything it sends. These tests are mostly about the
 * two messages such a script can legitimately originate — `fill:refill` and
 * `teach:picked` — and about the bus refusing anything it does not recognise.
 */

describe('the shape of the check', () => {
  it.each([
    ['null', null],
    ['a string', 'ping'],
    ['a number', 42],
    ['an object with no type', { tabId: 1 }],
    ['a type that is not a string', { type: 42 }],
  ])('refuses %s', (_name, request) => {
    expect(validateRequest(request).ok).toBe(false);
  });

  it('refuses a type nobody declared', () => {
    // Default-deny. A default-allow bus is one forgotten entry away from being
    // no check at all.
    const result = validateRequest({ type: 'vault:exfiltrate' });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/unknown message type/);
  });

  it('accepts a payload-free message', () => {
    expect(validateRequest({ type: 'ping' }).ok).toBe(true);
  });

  it('never echoes the payload in the refusal', () => {
    // A refusal is logged. A refusal that quoted the message would put the
    // rejected content into the log, which defeats the point of rejecting it.
    const result = validateRequest({ type: 'vault:unlock', passphrase: 'hunter2-the-real-one' });
    expect(result.reason ?? '').not.toContain('hunter2');
  });
});

describe('messages a compromised content script could send', () => {
  it('accepts a well-formed refill', () => {
    expect(validateRequest({ type: 'fill:refill', refs: ['f1', 'f2'] }).ok).toBe(true);
  });

  it.each([
    ['refs missing', { type: 'fill:refill' }],
    ['refs not an array', { type: 'fill:refill', refs: 'f1' }],
    ['refs holding objects', { type: 'fill:refill', refs: [{ evil: true }] }],
  ])('refuses a refill with %s', (_name, request) => {
    expect(validateRequest(request).ok).toBe(false);
  });

  it('refuses an absurdly long refill list', () => {
    const refs = Array.from({ length: LIMITS.array + 1 }, (_, i) => `f${i}`);
    expect(validateRequest({ type: 'fill:refill', refs }).ok).toBe(false);
  });

  it('accepts a well-formed pick', () => {
    const pick = {
      type: 'teach:picked',
      ref: 'f1',
      selectors: ['#a', 'input[name="b"]'],
      label: 'Candidate Name',
      tag: 'input',
    };
    expect(validateRequest(pick).ok).toBe(true);
  });

  it('accepts a pick with no known ref', () => {
    const pick = { type: 'teach:picked', ref: null, selectors: ['#a'], label: 'x', tag: 'input' };
    expect(validateRequest(pick).ok).toBe(true);
  });

  it.each([
    ['a numeric label', { ref: null, selectors: ['#a'], label: 42, tag: 'input' }],
    ['selectors as a string', { ref: null, selectors: '#a', label: 'x', tag: 'input' }],
    ['a missing tag', { ref: null, selectors: ['#a'], label: 'x' }],
    ['an object where refused should be text', { ref: null, selectors: ['#a'], label: 'x', tag: 'i', refused: {} }],
  ])('refuses a pick with %s', (_name, rest) => {
    expect(validateRequest({ type: 'teach:picked', ...rest }).ok).toBe(false);
  });

  it('refuses a selector long enough to be a denial of service', () => {
    const pick = {
      type: 'teach:picked',
      ref: null,
      selectors: ['#' + 'a'.repeat(LIMITS.string + 1)],
      label: 'x',
      tag: 'input',
    };
    expect(validateRequest(pick).ok).toBe(false);
  });
});

describe('vault messages', () => {
  it('accepts a normal unlock', () => {
    expect(validateRequest({ type: 'vault:unlock', passphrase: 'correct horse' }).ok).toBe(true);
  });

  it('caps the passphrase before it reaches the KDF', () => {
    // Argon2id at 64 MiB is deliberately slow. A megabyte-long "passphrase" is
    // not a user; it is a way to make the worker chew.
    const passphrase = 'a'.repeat(LIMITS.passphrase + 1);
    expect(validateRequest({ type: 'vault:unlock', passphrase }).ok).toBe(false);
  });

  it('insists a field key is a real key', () => {
    expect(validateRequest({ type: 'vault:set', key: 'identity.full_name', value: 'x' }).ok).toBe(
      true,
    );
    expect(validateRequest({ type: 'vault:set', key: 'anything.i.like', value: 'x' }).ok).toBe(
      false,
    );
  });

  it('refuses a document upload that is not bytes', () => {
    const base = { type: 'doc:put', key: 'doc.photo', label: 'Photo', mime: 'image/jpeg', width: 1, height: 1 };
    expect(validateRequest({ ...base, bytes: [0, 255, 128] }).ok).toBe(true);
    expect(validateRequest({ ...base, bytes: ['a'] }).ok).toBe(false);
    expect(validateRequest({ ...base, bytes: [999] }).ok).toBe(false);
    expect(validateRequest({ ...base, bytes: 'not an array' }).ok).toBe(false);
  });
});

describe('tab-addressed messages', () => {
  it.each([
    'harvest:tab',
    'fill:tab',
    'review:build',
    'approval:grant',
    'approval:submit',
    'teach:start',
    'profile:health',
  ])('%s needs a numeric tabId', (type) => {
    expect(validateRequest({ type, tabId: 7 }).ok).toBe(true);
    expect(validateRequest({ type, tabId: '7' }).ok).toBe(false);
    expect(validateRequest({ type }).ok).toBe(false);
  });

  it('rejects a tabId that is not a finite number', () => {
    expect(validateRequest({ type: 'fill:tab', tabId: Number.NaN }).ok).toBe(false);
    expect(validateRequest({ type: 'fill:tab', tabId: Infinity }).ok).toBe(false);
  });
});

describe('the table stays in step with the bus', () => {
  it('knows every privileged type', () => {
    // A privileged type missing from the validator would be a message that
    // reaches a handler unchecked — and privileged types are the ones that
    // touch the vault.
    const known = knownTypes();
    const missing = [...PRIVILEGED_TYPES].filter((type) => !known.has(type));

    expect(missing).toEqual([]);
  });

  it('does not list a type as both payload-free and checked', () => {
    const checked = new Set(knownTypes());
    for (const type of NO_PAYLOAD_TYPES) checked.delete(type);
    // Every remaining entry came from CHECKS; the two lists must not overlap,
    // or a payload-carrying message could take the payload-free path.
    const overlap = NO_PAYLOAD_TYPES.filter((type) => checked.has(type));
    expect(overlap).toEqual([]);
  });

  it('validates every message the extension actually sends', async () => {
    // Scans the source for `type: '...'` literals inside `envelope(...)` and
    // `send({...})` calls, so a message added anywhere without a schema entry
    // shows up here rather than at a user.
    const sources = import.meta.glob('../**/*.{ts,tsx}', {
      query: '?raw',
      import: 'default',
      eager: true,
    }) as Record<string, string>;

    const used = new Set<string>();
    for (const [path, source] of Object.entries(sources)) {
      if (path.includes('.test.')) continue;
      for (const match of source.matchAll(/\btype:\s*'([a-z]+:[a-z-]+|ping)'/gi)) {
        if (match[1]) used.add(match[1]);
      }
    }

    expect(used.size).toBeGreaterThan(20);
    const known = knownTypes();
    expect([...used].filter((type) => !known.has(type)).sort()).toEqual([]);
  });
});

describe('upload-all picks', () => {
  it('takes a document pick and refuses anything else', () => {
    expect(validateRequest({ type: 'approval:upload-all', tabId: 7, picks: { u0: 'doc.pan_card' } }).ok).toBe(true);
    expect(validateRequest({ type: 'approval:upload-all', tabId: 7, picks: { u0: 'id.aadhaar' } }).ok).toBe(false);
    expect(validateRequest({ type: 'approval:upload-all', tabId: 7, picks: ['doc.photo'] }).ok).toBe(false);
  });
});
