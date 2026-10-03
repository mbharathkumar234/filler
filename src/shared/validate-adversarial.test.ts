import { describe, expect, it } from 'vitest';

import { LIMITS, knownTypes, validateRequest } from './validate';
import { NO_PAYLOAD_TYPES } from './validate';

/**
 * The message validator, attacked (§ found by mutation testing).
 *
 * ## Why this file exists
 *
 * `validate.ts` is the default-deny door on the extension bus and a Phase 10
 * release gate. Coverage put it at 49% branch, and a mutation run put numbers
 * on what that meant: **45 of 50 surviving mutants were in this one file**.
 * Twenty-two `&&` operators could be flipped to `||` and four length caps
 * loosened without a single test noticing.
 *
 * The existing suite tested the door — unknown types refused, known types
 * accepted — and never tested the lock. Every per-type predicate was
 * decorative.
 *
 * ## How this is written
 *
 * Not by hand-writing a bad payload per field, which rots the moment somebody
 * adds a message type. Two properties do most of the work:
 *
 *  1. **A valid message is accepted.** Otherwise the rest proves nothing.
 *  2. **Removing any required field is refused.** This is the one that kills
 *     `&&` → `||` directly: under `||`, a message missing one required field
 *     still validates on the strength of the others, which is exactly the
 *     shape a compromised content script would send.
 *
 * Plus explicit cases for the types a page-side script can choose freely, and
 * boundary cases for every cap.
 *
 * The completeness test at the bottom means a new message type added to
 * `CHECKS` without a valid example here **fails the build** — the same
 * default-deny stance the validator itself takes.
 */

type Payload = Record<string, unknown>;

/**
 * One valid payload per type that carries data, plus which of its fields are
 * genuinely optional. Anything not listed as optional must be required, and
 * the removal property below enforces that.
 */
const VALID: Record<string, { payload: Payload; optional?: string[] }> = {
  'vault:create': { payload: { passphrase: 'a long enough passphrase' } },
  'vault:unlock': { payload: { passphrase: 'a long enough passphrase' } },
  'vault:reauth': { payload: { passphrase: 'a long enough passphrase' } },
  'vault:set': {
    payload: { key: 'identity.full_name', value: 'Ravi Kumar', fromDocument: true },
    optional: ['fromDocument'],
  },
  'vault:delete': { payload: { key: 'identity.full_name' } },
  'vault:export-chunk': { payload: { index: 0 } },
  'vault:import-chunk': { payload: { index: 0, text: '{}' } },
  'vault:import-commit': { payload: { passphrase: 'pass' } },
  'vault:set-path': {
    payload: {
      path: {
        version: 1,
        state: 'karnataka',
        board10: 'cbse',
        afterTen: 'puc',
        stream: 'pcmb',
        now: 'undergraduate',
        degreeFamily: 'engineering',
        entrance: ['kcet'],
        category: 'st',
        claims: ['371j'],
      },
    },
  },

  'doc:put': {
    payload: {
      key: 'doc.photo',
      label: 'Photograph',
      mime: 'image/jpeg',
      width: 800,
      height: 920,
      bytes: [1, 2, 3],
    },
  },
  'doc:delete': { payload: { id: 'doc-1' } },
  // A rendered page of a document, on its way to the reader.
  'ocr:recognise': {
    payload: { image: 'aGVsbG8=', mime: 'image/jpeg', scripts: ['Devanagari', 'Telugu'] },
    optional: ['scripts'],
  },
  // A stored photo, on its way to be made a clean scan.
  'ocr:scan': { payload: { image: 'aGVsbG8=', mime: 'image/jpeg' } },
  'doc:scan': { payload: { id: 'doc-1' } },
  // A PDF, on its way to the page that can open one (a service worker cannot load pdf.js).
  'pdf:lock': { payload: { pdf: 'JVBERi0=', password: 'RAVI1998' }, optional: ['password'] },
  'pdf:text': { payload: { pdf: 'JVBERi0=', password: 'RAVI1998' }, optional: ['password'] },
  'pdf:render': {
    payload: { pdf: 'JVBERi0=', password: 'RAVI1998', width: 2000, page: 2 },
    optional: ['password', 'page'],
  },
  'doc:derive': { payload: { key: 'doc.photo', constraint: {} } },
  'doc:extract': { payload: { id: 'doc-1' } },
  'doc:preflight': { payload: { key: 'doc.photo', constraint: {} } },
  'doc:to-window': {
    payload: { tabId: 7, slotRef: 'u0', mode: 'drop', key: 'doc.photo' },
    optional: ['mode', 'key'],
  },

  'harvest:tab': { payload: { tabId: 7 } },
  'fill:tab': { payload: { tabId: 7 } },
  'fill:undo:tab': { payload: { tabId: 7 } },
  'fill:apply': { payload: { writes: [] } },
  'fill:refill': { payload: { refs: ['f1'] } },
  'fill:submit': { payload: { token: {} } },
  'fill:press-upload': { payload: { token: {}, ref: 'f3' } },

  'review:build': { payload: { tabId: 7 } },
  'review:collect': { payload: { refs: ['f1'] } },
  'field:focus': { payload: { ref: 'f1' } },
  'field:apply-edit': { payload: { ref: 'f1', value: 'v' } },
  'field:highlight': { payload: { tabId: 7, ref: 'f1' } },
  'field:edit': {
    payload: { tabId: 7, ref: 'f1', value: 'v', saveKey: 'identity.full_name' },
    optional: ['saveKey'],
  },

  'approval:grant': { payload: { tabId: 7 } },
  'approval:submit': { payload: { tabId: 7 } },
  'approval:revoke': { payload: { tabId: 7 } },
  'approval:status': { payload: { tabId: 7 } },
  'approval:upload': { payload: { tabId: 7, ref: 'f3' } },
  'approval:upload-all': { payload: { tabId: 7, picks: { u0: 'doc.photo' } }, optional: ['picks'] },

  // Every field optional — `audit:read` with no limit is a legitimate message,
  // so the removal property below has nothing to assert for it.
  'audit:read': { payload: { limit: 50 }, optional: ['limit'] },
  'audit:configure': { payload: { logValues: true } },

  'llm:set-key': { payload: { apiKey: 'sk-ant-xxx' } },
  'llm:set-model': { payload: { model: 'claude-sonnet-5' } },

  'teach:start': { payload: { tabId: 7 } },
  'teach:stop': { payload: { tabId: 7 } },
  'teach:cancel': { payload: { tabId: 7 } },
  'teach:session': { payload: { tabId: 7 } },
  'teach:save': { payload: { tabId: 7 } },
  'teach:picked': {
    payload: { ref: 'f1', selectors: ['#a'], label: 'Name', tag: 'input', refused: undefined },
    optional: ['refused'],
  },
  'teach:assign': {
    payload: { tabId: 7, key: 'identity.full_name', ref: 'f1', selectors: ['#a'], label: 'Name' },
  },
  'teach:assign-document': {
    payload: {
      tabId: 7,
      key: 'doc.photo',
      ref: 'f1',
      selectors: ['#a'],
      label: 'Photo',
      constraint: {},
    },
  },
  'teach:forget': { payload: { tabId: 7, key: 'identity.full_name' } },

  'profile:health': { payload: { tabId: 7 } },
  'profile:versions': { payload: { fingerprint: 'fp-abc' } },
  'profile:rollback': { payload: { fingerprint: 'fp-abc' } },
  'profile:import': { payload: { text: '{}' } },

  'guard:status': { payload: { tabId: 7 } },
  'guard:enable': { payload: { tabId: 7 } },
  'guard:disable': { payload: { origin: 'https://portal.example.gov.in' } },

  'run:state': { payload: { state: { t: 'IDLE' } } },
  'run:abort': { payload: { why: 'user closed the panel' } },
  'run:save': { payload: { fingerprint: 'fp-abc', state: { t: 'IDLE' } } },
  'run:load': { payload: { fingerprint: 'fp-abc' } },
  'run:clear': { payload: { fingerprint: 'fp-abc' } },
};

const TYPED = Object.entries(VALID);

// ---------------------------------------------------------------------------

describe('the table is complete, or the build fails', () => {
  it('has a valid example for every type that carries data', () => {
    // Default-deny applied to the tests themselves. A message type added to
    // `CHECKS` with no adversarial case here is a predicate nothing constrains
    // — which is the state this whole file was written to end.
    const noPayload = new Set<string>(NO_PAYLOAD_TYPES);
    const missing = [...knownTypes()].filter(
      (type) => !noPayload.has(type) && !(type in VALID),
    );
    expect(missing.sort()).toEqual([]);
  });

  it('names no type the validator does not know', () => {
    const unknown = Object.keys(VALID).filter((type) => !knownTypes().has(type));
    expect(unknown.sort()).toEqual([]);
  });
});

describe('a well-formed message is accepted', () => {
  it.each(TYPED)('%s', (type, { payload }) => {
    const result = validateRequest({ type, ...payload });
    expect(result.reason ?? '').toBe('');
    expect(result.ok).toBe(true);
  });
});

describe('removing a required field is refused', () => {
  /**
   * The property that kills `&&` → `||`.
   *
   * Under `||`, `key(r.key) && str(r.value)` becomes `key(r.key) ||
   * str(r.value)` — and a message carrying a valid `value` but no `key` at all
   * sails through to a handler that will then read `undefined` as a taxonomy
   * key. Every predicate in the table is a conjunction of exactly this shape.
   */
  it.each(TYPED)('%s', (type, { payload, optional }) => {
    const required = Object.keys(payload).filter((field) => !(optional ?? []).includes(field));

    const accepted: string[] = [];
    for (const field of required) {
      const without = { ...payload };
      delete without[field];
      if (validateRequest({ type, ...without }).ok) accepted.push(field);
    }
    expect(accepted, `${type} accepted a message missing these`).toEqual([]);
  });
});

describe('an explicit undefined is refused too', () => {
  // `delete` and `= undefined` are different objects and a hand-written
  // predicate can treat them differently. A structured-clone round trip over
  // the bus turns one into the other, so both have to be refused.
  it.each(TYPED)('%s', (type, { payload, optional }) => {
    const accepted: string[] = [];
    for (const field of Object.keys(payload)) {
      if ((optional ?? []).includes(field)) continue;
      if (validateRequest({ type, ...payload, [field]: undefined }).ok) accepted.push(field);
    }
    expect(accepted).toEqual([]);
  });
});

describe('an optional field is optional, but still checked when present', () => {
  it('audit:read takes no limit, but refuses a bad one', () => {
    expect(validateRequest({ type: 'audit:read' }).ok).toBe(true);
    expect(validateRequest({ type: 'audit:read', limit: 'lots' }).ok).toBe(false);
    expect(validateRequest({ type: 'audit:read', limit: Number.NaN }).ok).toBe(false);
    expect(validateRequest({ type: 'audit:read', limit: Infinity }).ok).toBe(false);
  });

  it('field:edit takes no saveKey, but refuses a key outside the taxonomy', () => {
    const base = { type: 'field:edit', tabId: 7, ref: 'f1', value: 'v' };
    expect(validateRequest(base).ok).toBe(true);
    expect(validateRequest({ ...base, saveKey: 'identity.full_name' }).ok).toBe(true);
    expect(validateRequest({ ...base, saveKey: 'not.a.real.key' }).ok).toBe(false);
    expect(validateRequest({ ...base, saveKey: '__proto__' }).ok).toBe(false);
  });

  it('teach:picked takes no refusal reason, but refuses an oversize one', () => {
    const base = { type: 'teach:picked', ref: 'f1', selectors: ['#a'], label: 'L', tag: 'input' };
    expect(validateRequest(base).ok).toBe(true);
    expect(validateRequest({ ...base, refused: 'x'.repeat(501) }).ok).toBe(false);
  });

  it('a nullable field accepts null and still refuses a number', () => {
    expect(validateRequest({ type: 'llm:set-key', apiKey: null }).ok).toBe(true);
    expect(validateRequest({ type: 'llm:set-key', apiKey: 42 }).ok).toBe(false);
    expect(validateRequest({ type: 'llm:set-model', model: null }).ok).toBe(true);
    expect(validateRequest({ type: 'llm:set-model', model: {} }).ok).toBe(false);

    const picked = { type: 'teach:picked', selectors: ['#a'], label: 'L', tag: 'input' };
    expect(validateRequest({ ...picked, ref: null }).ok).toBe(true);
    expect(validateRequest({ ...picked, ref: 7 }).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The caps
// ---------------------------------------------------------------------------

describe('the scripts a page is read in', () => {
  /*
   * Each names a recogniser the reader may load. A name that is not one of the
   * scripts is refused, not ignored: the bus is where a malformed request
   * stops.
   */
  const asked = (scripts: unknown) =>
    validateRequest({ type: 'ocr:recognise', image: 'aGVsbG8=', mime: 'image/png', scripts } as never).ok;

  it('accepts the scripts there are, and none at all', () => {
    expect(asked(['Devanagari', 'Tamil', 'Telugu'])).toBe(true);
    expect(asked([])).toBe(true);
  });

  it('refuses a script that is not one, or a list that is not a list of them', () => {
    expect(asked(['Klingon'])).toBe(false);
    expect(asked('Devanagari')).toBe(false);
    expect(asked([1])).toBe(false);
    expect(asked(Array.from({ length: 40 }, () => 'Tamil'))).toBe(false);
  });
});

describe('the caps hold at the boundary, in both directions', () => {
  /**
   * Mutation testing loosened four `<=` to `<` and nothing failed, which means
   * no test ever handed the validator a value of exactly the maximum length.
   * Both sides matter: a cap that rejects the largest legal message is a bug
   * users hit, and a cap that accepts one byte too many is the cap not
   * existing.
   */
  it('accepts a string of exactly the maximum length', () => {
    expect(validateRequest({ type: 'run:abort', why: 'x'.repeat(500) }).ok).toBe(true);
    expect(validateRequest({ type: 'vault:set', key: 'identity.full_name', value: 'x'.repeat(LIMITS.string) }).ok).toBe(true);
  });

  it('refuses a string one character over', () => {
    expect(validateRequest({ type: 'run:abort', why: 'x'.repeat(501) }).ok).toBe(false);
    expect(validateRequest({ type: 'vault:set', key: 'identity.full_name', value: 'x'.repeat(LIMITS.string + 1) }).ok).toBe(false);
  });

  it('accepts a passphrase of exactly the maximum length, and refuses one over', () => {
    // A cap here is not cosmetic: the passphrase is fed to Argon2id at 64 MiB
    // per pass, and an unbounded one is a denial-of-service against our own
    // worker.
    expect(validateRequest({ type: 'vault:unlock', passphrase: 'x'.repeat(LIMITS.passphrase) }).ok).toBe(true);
    expect(validateRequest({ type: 'vault:unlock', passphrase: 'x'.repeat(LIMITS.passphrase + 1) }).ok).toBe(false);
  });

  it('accepts an array of exactly the maximum length, and refuses one over', () => {
    const at = new Array(LIMITS.array).fill('f1');
    const over = new Array(LIMITS.array + 1).fill('f1');
    expect(validateRequest({ type: 'fill:refill', refs: at }).ok).toBe(true);
    expect(validateRequest({ type: 'fill:refill', refs: over }).ok).toBe(false);
    expect(validateRequest({ type: 'review:collect', refs: over }).ok).toBe(false);
  });

  it('refuses a document larger than the derivation cap', () => {
    const over = { type: 'doc:put', key: 'doc.photo', label: 'L', mime: 'image/jpeg', width: 1, height: 1, bytes: { length: LIMITS.bytes + 1 } };
    expect(validateRequest(over).ok).toBe(false);
  });

  it('accepts a document of exactly the cap, and refuses one byte more', () => {
    // A sparse array, so this costs nothing to allocate: `length` is what the
    // cap is checked against, and `every` skips holes. The point is the
    // boundary, and a 10 MB dense array would make the test suite pay for it.
    const doc = (length: number) => ({
      type: 'doc:put',
      key: 'doc.photo',
      label: 'L',
      mime: 'image/jpeg',
      width: 8,
      height: 8,
      bytes: new Array(length) as unknown[],
    });
    expect(validateRequest(doc(LIMITS.bytes)).ok).toBe(true);
    expect(validateRequest(doc(LIMITS.bytes + 1)).ok).toBe(false);
  });

  it('accepts exactly the maximum number of writes, and refuses one more', () => {
    const writes = (length: number) => ({ type: 'fill:apply', writes: new Array(length) as unknown[] });
    expect(validateRequest(writes(LIMITS.array)).ok).toBe(true);
    expect(validateRequest(writes(LIMITS.array + 1)).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The types a page-side script chooses freely
// ---------------------------------------------------------------------------

describe('content-script originated messages, checked in full', () => {
  /**
   * `validate.ts` names these two itself: they are the shapes "a compromised
   * page-side script could choose freely". Everything else on the bus comes
   * from our own UI.
   */
  it('teach:picked refuses every wrong-typed field', () => {
    const base = { type: 'teach:picked', ref: 'f1', selectors: ['#a'], label: 'L', tag: 'input' };
    const attacks: Payload[] = [
      { selectors: 'a string, not an array' },
      { selectors: [1, 2, 3] },
      { selectors: [{ toString: 'not a string' }] },
      { selectors: new Array(LIMITS.array + 1).fill('#a') },
      { selectors: ['x'.repeat(LIMITS.string + 1)] },
      { label: 'x'.repeat(501) },
      { label: 42 },
      { tag: 'x'.repeat(51) },
      { tag: null },
      { ref: 'x'.repeat(201) },
      { ref: [] },
    ];
    for (const attack of attacks) {
      expect(validateRequest({ ...base, ...attack }).ok, JSON.stringify(attack).slice(0, 60)).toBe(false);
    }
  });

  it('fill:refill refuses anything but a bounded list of strings', () => {
    const attacks: unknown[] = [
      'f1',
      [1],
      [null],
      [{}],
      [['nested']],
      new Array(LIMITS.array + 1).fill('f1'),
      ['x'.repeat(LIMITS.string + 1)],
      { length: 3 },
    ];
    for (const refs of attacks) {
      expect(validateRequest({ type: 'fill:refill', refs }).ok, JSON.stringify(refs)?.slice(0, 40)).toBe(false);
    }
  });

  it('doc:put refuses bytes that are not bytes', () => {
    const base = { type: 'doc:put', key: 'doc.photo', label: 'L', mime: 'image/jpeg', width: 8, height: 8 };
    const attacks: unknown[] = [
      'not an array',
      [256],
      [-1],
      [1.5e308],
      [null],
      ['0'],
      [{}],
      [Number.NaN],
    ];
    for (const bytes of attacks) {
      expect(validateRequest({ ...base, bytes }).ok, JSON.stringify(bytes)).toBe(false);
    }
  });

  it('doc:put carries a locked PDF’s password, and nothing shaped otherwise', () => {
    const base = { type: 'doc:put', key: 'doc.aadhaar_card', label: 'L', mime: 'application/pdf', width: 0, height: 0, bytes: [1] };
    expect(validateRequest(base).ok).toBe(true);
    expect(validateRequest({ ...base, password: 'RAVI1998' }).ok).toBe(true);
    // A PDF password is at most 127 bytes; anything far past that is not one.
    for (const bad of ['x'.repeat(257), 1998, null, {}, ['RAVI1998']]) {
      expect(validateRequest({ ...base, password: bad }).ok, JSON.stringify(bad)?.slice(0, 20)).toBe(false);
    }
  });

  it('doc:put refuses non-finite dimensions', () => {
    const base = { type: 'doc:put', key: 'doc.photo', label: 'L', mime: 'image/jpeg', bytes: [1] };
    for (const bad of [Number.NaN, Infinity, -Infinity, '800', null, {}]) {
      expect(validateRequest({ ...base, width: bad, height: 8 }).ok, String(bad)).toBe(false);
      expect(validateRequest({ ...base, width: 8, height: bad }).ok, String(bad)).toBe(false);
    }
  });
});

describe('taxonomy keys are checked, not merely typed as strings', () => {
  it('refuses a key that is not in the taxonomy', () => {
    for (const key of ['', 'nonsense', 'identity', 'identity.', '__proto__', 'constructor', 'toString']) {
      expect(validateRequest({ type: 'vault:delete', key }).ok, key).toBe(false);
    }
  });

  it('refuses a key that is the right shape but a different type', () => {
    for (const key of [null, 42, {}, ['identity.full_name']]) {
      expect(validateRequest({ type: 'vault:delete', key }).ok, String(key)).toBe(false);
    }
  });
});

describe('the door itself', () => {
  it('refuses anything that is not an object', () => {
    for (const junk of [null, undefined, 'ping', 42, true, [], Symbol.iterator]) {
      expect(validateRequest(junk).ok, String(junk)).toBe(false);
    }
  });

  it('refuses an object with no usable type', () => {
    for (const type of [undefined, null, 42, {}, ['ping']]) {
      expect(validateRequest({ type }).ok, String(type)).toBe(false);
    }
  });

  it('refuses an unknown type even when it carries a plausible payload', () => {
    expect(validateRequest({ type: 'vault:exfiltrate', key: 'identity.full_name' }).ok).toBe(false);
    expect(validateRequest({ type: 'vault:status ', }).ok).toBe(false); // trailing space
    expect(validateRequest({ type: 'VAULT:STATUS' }).ok).toBe(false);
  });

  it('is not fooled by a type inherited from the prototype chain', () => {
    const sneaky = Object.create({ type: 'vault:status' }) as object;
    expect(validateRequest(sneaky).ok).toBe(false);
  });

  it('never echoes the payload in the refusal reason', () => {
    // The reason reaches the worker's log. A refusal that quoted the message
    // would put the thing we refused into the log instead.
    const secret = 'AADHAAR-1234-5678-9012';
    const result = validateRequest({ type: 'vault:set', key: 'identity.full_name', value: { secret } });
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(secret);
  });
});
