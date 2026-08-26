// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';

import {
  checkPayloadSchema,
  denyListFrom,
  guardPayload,
  isCategorical,
  payloadFields,
  protectedKeys,
  REDACTED,
} from './value-guard';
import { redactFields } from './redaction';
import { harvest } from '@/content/harvester';
import { FIELD_KEYS, type FieldKey } from '@/matching/taxonomy';

/**
 * The value guard — the plan's leak test, in the form it actually asks for.
 *
 *   "Seed the vault with canary strings; run the matcher over all fixtures;
 *    assert no canary appears in any outbound payload. This test is mandatory
 *    in CI."
 *
 * `redaction.test.ts` covers what syntax can catch. This file covers what only
 * the vault can: the user's name, their street, their father's name — strings
 * with no shape at all, which a portal cheerfully prints back at them.
 */

const VAULT: ReadonlyArray<{ key: FieldKey; value: string }> = [
  { key: 'identity.full_name', value: 'Ravi Kumar Chandrasekaran' },
  { key: 'family.father_name', value: 'Suresh Kumar Chandrasekaran' },
  { key: 'address.permanent.line1', value: '14 Nandidurga Extension' },
  { key: 'address.permanent.city', value: 'Bengaluru' },
  { key: 'id.aadhaar', value: '234567890123' },
  { key: 'id.pan', value: 'ABCDE1234F' },
  { key: 'contact.email', value: 'ravi.canary@example.com' },
  { key: 'bank.account_number', value: '00112233445566' },
  // Categorical: the portal prints these in its own dropdowns.
  { key: 'address.permanent.state', value: 'Karnataka' },
  { key: 'identity.gender', value: 'Male' },
  { key: 'identity.category', value: 'General' },
];

describe('building the denylist', () => {
  it('includes the whole value and its long tokens', () => {
    const deny = denyListFrom([{ key: 'identity.full_name', value: 'Ravi Kumar Chandrasekaran' }]);

    expect(deny).toContain('Ravi Kumar Chandrasekaran');
    expect(deny).toContain('Chandrasekaran');
    expect(deny).toContain('Kumar');
    expect(deny).toContain('Ravi');
  });

  it('leaves short tokens alone', () => {
    // Scrubbing every three-letter token would take chunks out of ordinary
    // page text without protecting anything a whole-value match would miss.
    const deny = denyListFrom([{ key: 'identity.full_name', value: 'A B Rai' }]);
    expect(deny).not.toContain('Rai');
    expect(deny).toContain('A B Rai');
  });

  it('orders longest first, so one name does not become three placeholders', () => {
    const deny = denyListFrom([{ key: 'identity.full_name', value: 'Ravi Kumar' }]);
    expect(deny[0]).toBe('Ravi Kumar');
  });

  it('leaves categorical values out — they are the portal’s own vocabulary', () => {
    const deny = denyListFrom([
      { key: 'address.permanent.state', value: 'Karnataka' },
      { key: 'identity.gender', value: 'Male' },
    ]);
    expect(deny).toEqual([]);
  });

  it('ignores empty entries', () => {
    expect(denyListFrom([{ key: 'identity.full_name', value: '   ' }])).toEqual([]);
  });
});

describe('the categorical list fails closed', () => {
  it('protects every key it has not explicitly exempted', () => {
    // A key added to the taxonomy tomorrow is scrubbed by default. This is the
    // property that matters: the list of things we send is opt-in, not opt-out.
    const exempt = FIELD_KEYS.filter(isCategorical);
    const guarded = protectedKeys();

    expect(guarded.length + exempt.length).toBe(FIELD_KEYS.length);
    expect(guarded).toContain('identity.full_name');
    expect(guarded).toContain('id.aadhaar');
    expect(guarded).toContain('address.permanent.line1');
  });

  it('exempts only values a portal already offers everyone', () => {
    for (const key of FIELD_KEYS.filter(isCategorical)) {
      expect(
        /gender|category|nationality|marital|religion|tongue|state|district|country|account_type/.test(key),
        `${key} is exempt but does not look categorical`,
      ).toBe(true);
    }
  });
});

describe('THE LEAK SUITE — vault canaries against a real page', () => {
  /**
   * A portal on the user's second visit: their name in the heading and the
   * legend, their address printed for confirmation, values in the inputs.
   */
  const FILLED_PORTAL = `
    <h1>Welcome back, Ravi Kumar Chandrasekaran</h1>
    <p>Registered address: 14 Nandidurga Extension, Bengaluru</p>

    <fieldset>
      <legend>Personal Details — Ravi Kumar Chandrasekaran</legend>

      <label for="a">Candidate Name</label>
      <input id="a" name="txtName" value="Ravi Kumar Chandrasekaran" />

      <label for="b">Father's Name</label>
      <input id="b" name="txtFather" value="Suresh Kumar Chandrasekaran"
             placeholder="e.g. Suresh Kumar Chandrasekaran" />

      <label for="c">Aadhaar Number</label>
      <input id="c" name="txtUID" value="234567890123" />

      <label for="d">Address Line 1</label>
      <input id="d" name="txtAddr" value="14 Nandidurga Extension" />

      <label for="e">Email ID</label>
      <input id="e" name="txtEmail" type="email" value="ravi.canary@example.com" />

      <label for="f">State</label>
      <select id="f" name="ddlState">
        <option value="KA">Karnataka</option>
        <option value="TN">Tamil Nadu</option>
      </select>
    </fieldset>
  `;

  function guardedPayloadFor(html: string): string {
    document.body.innerHTML = html;
    const redacted = redactFields(harvest(document).fields);
    const outcome = guardPayload(redacted.fields, denyListFrom(VAULT));
    expect(outcome.payload).not.toBeNull();
    return JSON.stringify(payloadFields(outcome.payload!));
  }

  it('lets no canary through — including the ones with no shape', () => {
    const payload = guardedPayloadFor(FILLED_PORTAL);

    for (const entry of VAULT) {
      if (isCategorical(entry.key)) continue;
      expect(payload, `${entry.key} reached the payload`).not.toContain(entry.value);
    }
  });

  it('catches a surname printed on its own', () => {
    const payload = guardedPayloadFor(`
      <label for="a">Surname</label><input id="a" name="txtSurname" />
      <p>Shown on your card as: Chandrasekaran</p>
    `);
    expect(payload).not.toContain('Chandrasekaran');
  });

  it('catches a value the portal upper-cased', () => {
    const payload = guardedPayloadFor(`
      <label for="a">Name as on certificate</label>
      <input id="a" name="txtCert" />
      <p>RAVI KUMAR CHANDRASEKARAN</p>
    `);
    expect(payload.toLowerCase()).not.toContain('chandrasekaran');
  });

  it('keeps the portal’s own dropdown vocabulary intact', () => {
    // The counterweight. A guard that scrubbed "Karnataka" would protect
    // nobody — the portal offers it to every visitor — and would leave the
    // model unable to match a State field at all.
    const payload = guardedPayloadFor(FILLED_PORTAL);

    expect(payload).toContain('Karnataka');
    expect(payload).toContain('Tamil Nadu');
  });

  it('still leaves the labels the model needs', () => {
    const payload = guardedPayloadFor(FILLED_PORTAL);

    for (const word of ['Candidate Name', 'Aadhaar', 'Address Line 1', 'Email', 'State']) {
      expect(payload, `label "${word}" should survive`).toContain(word);
    }
  });

  it('reports how much it removed, so a silent no-op is visible', () => {
    document.body.innerHTML = FILLED_PORTAL;
    const redacted = redactFields(harvest(document).fields);
    const outcome = guardPayload(redacted.fields, denyListFrom(VAULT));

    expect(outcome.removed).toBeGreaterThan(0);
  });

  it('leaks nothing across every fixture in the corpus', () => {
    const pages = import.meta.glob('../../fixtures/*/*.html', {
      query: '?raw',
      eager: true,
    }) as Record<string, { default: string }>;

    expect(Object.keys(pages).length).toBeGreaterThan(3);
    const deny = denyListFrom(VAULT);

    for (const [path, module] of Object.entries(pages)) {
      document.documentElement.innerHTML = module.default;
      const redacted = redactFields(harvest(document).fields);
      const outcome = guardPayload(redacted.fields, deny);

      expect(outcome.payload, `${path} was refused`).not.toBeNull();
      const payload = JSON.stringify(payloadFields(outcome.payload!));

      for (const entry of VAULT) {
        if (isCategorical(entry.key)) continue;
        expect(payload, `${path} leaked ${entry.key}`).not.toContain(entry.value);
      }
    }
  });
});

describe('failing closed', () => {
  it('refuses the payload rather than sending a survivor', () => {
    // Simulated by handing the guard a needle it cannot escape into: the
    // scrub replaces `[redacted]` itself, so the marker survives and the
    // check fires. Contrived, and that is the point — the branch has to work
    // the day something real trips it.
    const outcome = guardPayload([{ ref: 'f1', label: `x ${REDACTED} x` }], [REDACTED]);

    expect(outcome.payload).toBeNull();
    expect(outcome.refused).toMatch(/survived redaction/i);
  });

  it('never quotes the leaked value in its own refusal message', () => {
    const outcome = guardPayload([{ ref: 'f1', label: `x ${REDACTED} x` }], [REDACTED]);
    expect(outcome.refused).not.toContain(REDACTED);
  });

  it('an empty denylist guards nothing but still produces a payload', () => {
    // The vault being locked is handled by the caller declining to call at
    // all — see llm-matcher. Here the guard just does nothing gracefully.
    const outcome = guardPayload([{ ref: 'f1', label: 'Candidate Name' }], []);

    expect(outcome.payload).not.toBeNull();
    expect(outcome.removed).toBe(0);
  });
});

describe('the outbound schema (§ Phase C)', () => {
  it('accepts exactly the properties the contract names', () => {
    const outcome = guardPayload(
      [
        {
          ref: 'f1',
          label: 'Candidate Name',
          name: 'txtName',
          type: 'text',
          maxLength: 60,
          nearby: 'Personal Details',
          options: ['A', 'B'],
          required: true,
        },
      ],
      [],
    );
    expect(outcome.payload).not.toBeNull();
  });

  it.each([
    ['a stray value', { value: 'Ravi Kumar' }],
    ['document bytes', { bytes: [1, 2, 3] }],
    ['a filename', { filename: 'aadhaar-scan.jpg' }],
    ['a nested object', { meta: { anything: 'at all' } }],
  ])('refuses a payload carrying %s', (_name, extra) => {
    // `RedactedField` makes this impossible by construction — until somebody
    // spreads a wider object through an `as`, an `any`, or a JSON round-trip.
    const outcome = guardPayload(
      [{ ref: 'f1', label: 'Name', ...extra } as never],
      [],
    );

    expect(outcome.payload).toBeNull();
    expect(outcome.refused).toMatch(/not in the contract/i);
  });

  it('refuses options that are objects rather than plain strings', () => {
    // An array of objects is exactly where something would ride along.
    const outcome = guardPayload(
      [{ ref: 'f1', label: 'State', options: [{ value: 'KA', text: 'Karnataka' }] } as never],
      [],
    );
    expect(outcome.payload).toBeNull();
  });

  it('names the property but never quotes its contents', () => {
    const outcome = guardPayload(
      [{ ref: 'f1', label: 'Name', value: '234567890123' } as never],
      [],
    );
    expect(outcome.refused).toContain('value');
    expect(outcome.refused).not.toContain('234567890123');
  });
});

describe('THE FILENAME CANARY (§ Phase C-4)', () => {
  /**
   * The plan asks for the document path to be verified "by the same canary
   * mechanism using a canary filename".
   *
   * Document bytes are unreachable from the LLM path by module boundary —
   * `redaction.ts` cannot import `documents/`, proved by lint. A filename is
   * different: it is a *string*, and strings travel. A page that shows
   * "Currently uploaded: aadhaar-scan-ravi.jpg" beside a file input puts one
   * into exactly the label text the plan permits sending.
   */
  const FILENAME = 'aadhaar-scan-ravi-kumar.jpg';

  it('never lets an uploaded filename out through page text', () => {
    document.body.innerHTML = `
      <label for="f">Upload Aadhaar</label>
      <input id="f" name="fileAadhaar" type="file" />
      <p>Currently uploaded: ${FILENAME}</p>
    `;

    const redacted = redactFields(harvest(document).fields);
    const outcome = guardPayload(redacted.fields, denyListFrom([]));

    expect(outcome.payload).not.toBeNull();
    expect(JSON.stringify(payloadFields(outcome.payload!))).not.toContain(FILENAME);
  });

  it('never lets it out through a file input’s own value attribute', () => {
    document.body.innerHTML = `
      <label for="f">Upload Aadhaar</label>
      <input id="f" name="fileAadhaar" type="file" value="${FILENAME}"
             placeholder="${FILENAME}" title="${FILENAME}" />
    `;

    const redacted = redactFields(harvest(document).fields);
    const outcome = guardPayload(redacted.fields, denyListFrom([]));

    expect(JSON.stringify(payloadFields(outcome.payload!))).not.toContain(FILENAME);
  });

  it('still says the field is a file upload, which is what the model needs', () => {
    // The counterweight: a redaction that erased the field entirely would pass
    // every canary check and leave the model unable to identify it.
    document.body.innerHTML = `
      <label for="f">Upload Aadhaar</label>
      <input id="f" name="fileAadhaar" type="file" />
    `;

    const redacted = redactFields(harvest(document).fields);
    const payload = JSON.stringify(redacted.fields);

    expect(payload).toContain('Aadhaar');
    expect(payload).toContain('file');
  });
});

describe('the branded payload', () => {
  it('is the only thing the client can be handed', () => {
    // Structural, not a convention: `GuardedPayload` carries a unique symbol
    // that nothing outside this module can produce, so calling the model with
    // an unguarded payload is a type error rather than an oversight.
    const source = Object.values(
      import.meta.glob('./value-guard.ts', { query: '?raw', eager: true }) as Record<
        string,
        { default: string }
      >,
    )[0]?.default;

    expect(source).toContain('declare const guarded: unique symbol');
  });
});

describe('a nested object under a permitted name (§ mutation-testing gap)', () => {
  /**
   * The Phase C schema check has two halves: the property *name* must be on
   * the allow-list, and its value must not be an object. Every existing test
   * exercised the first half — a rogue property called `filename` or `bytes`.
   * None exercised the second, and mutation testing found it: flipping
   * `value !== null` to `value === null` in `checkPayloadSchema` broke nothing.
   *
   * That half is the one that matters more. `filename` is refused because
   * somebody thought of the name `filename`. A nested object hidden under
   * `label` — a name nobody would think to deny — is how something rides along
   * that nobody thought of.
   */
  const nest = (over: Record<string, unknown>) =>
    checkPayloadSchema([{ ref: 'f1', label: 'Name', ...over } as never]);

  it('refuses an object where a string belongs', () => {
    for (const name of ['label', 'name', 'type', 'nearby', 'pattern']) {
      const result = nest({ [name]: { toString: () => 'Name', secret: 'AADHAAR' } });
      expect(result.ok, name).toBe(false);
      expect(result.offender, name).toBe(name);
    }
  });

  it('refuses an array where a string belongs', () => {
    expect(nest({ label: ['Name'] }).ok).toBe(false);
    expect(nest({ nearby: [] }).ok).toBe(false);
  });

  it('refuses a nested object even on a numeric field', () => {
    expect(nest({ maxLength: { valueOf: () => 10 } }).ok).toBe(false);
  });

  it('refuses options that are objects rather than strings', () => {
    expect(checkPayloadSchema([{ ref: 'f1', label: 'S', options: [{ v: 'x' }] } as never]).ok).toBe(false);
    expect(checkPayloadSchema([{ ref: 'f1', label: 'S', options: 'not an array' } as never]).ok).toBe(false);
  });

  it('still accepts the shapes a real redacted field has', () => {
    // The check must not have become "refuse everything", which would pass
    // every test above and send nothing ever again.
    expect(
      checkPayloadSchema([
        { ref: 'f1', label: 'Name', name: 'txtName', type: 'text', maxLength: 75, required: true },
        { ref: 'f2', label: 'State', options: ['Karnataka', 'Kerala'], nearby: 'Address' },
      ] as never),
    ).toEqual({ ok: true });
  });

  it('accepts null where a value is simply absent', () => {
    // `null` is not an object smuggling anything; refusing it would break a
    // legitimate field that carries no pattern.
    expect(checkPayloadSchema([{ ref: 'f1', label: 'N', pattern: null } as never]).ok).toBe(true);
  });
});
