// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';

import { identifierOf, redactFields, scrubText, type RedactedField } from './redaction';
import { harvest } from '@/content/harvester';
import type { FieldDescriptor } from '@/shared/types';

/**
 * The redaction layer, and the leak suite the plan makes CI-blocking.
 *
 *   "Seed the vault with canary strings; run the matcher over all fixtures;
 *    assert no canary appears in any outbound payload."
 *
 * That test as written would pass trivially — the module boundary means vault
 * values cannot reach this code at all, so a canary in the vault can never
 * appear in a payload no matter how badly this file is written. It is a real
 * guarantee and it is worth asserting, but it is not the interesting one.
 *
 * The interesting one is that **the page contains the user's data too**. A
 * portal that has already been filled in, or that greets the user by name, or
 * that prints a masked Aadhaar beside the field, puts PII into precisely the
 * label and nearby text the plan says are safe to send. So the canaries here
 * are planted in the *DOM*, harvested for real, and then checked for — which
 * is the version of this test that can actually fail.
 */

// ---------------------------------------------------------------------------
// Canaries — distinctive enough that a substring match cannot be a false pass
// ---------------------------------------------------------------------------

const CANARIES = {
  name: 'Ravi Kumar Chandrasekaran',
  aadhaar: '234567890123',
  aadhaarSpaced: '2345 6789 0123',
  pan: 'ABCDE1234F',
  email: 'ravi.canary@example.com',
  mobile: '9876543210',
  account: '00112233445566',
  ifsc: 'HDFC0001234',
  dob: '01/04/2001',
  applicationNo: 'SC2024889231',
} as const;

function field(over: Partial<FieldDescriptor> & { ref: string }): FieldDescriptor {
  return {
    selectors: [`#${over.ref}`],
    tag: 'input',
    labelText: 'A field',
    nearbyText: '',
    required: false,
    frameId: 0,
    visible: true,
    enabled: true,
    ...over,
  };
}

function payloadText(fields: readonly FieldDescriptor[]): string {
  return JSON.stringify(redactFields(fields).fields);
}

// ---------------------------------------------------------------------------

describe('what a payload is allowed to contain', () => {
  it('carries the label, name, type and nearby text the plan lists', () => {
    const report = redactFields([
      field({
        ref: 'f1',
        selectors: ['#txtFName', 'input[name="txtFName"]'],
        labelText: "पिता का नाम / Father's Name",
        nearbyText: 'Personal Details',
        type: 'text',
        maxLength: 50,
        required: true,
      }),
    ]);

    expect(report.fields[0]).toEqual({
      ref: 'f1',
      label: "पिता का नाम / Father's Name",
      name: 'txtFName',
      type: 'text',
      maxLength: 50,
      nearby: 'Personal Details',
      required: true,
    } satisfies RedactedField);
  });

  it('sends option text, never option values', () => {
    // A portal's option values are frequently codes tied to the user's record.
    const report = redactFields([
      field({
        ref: 'f1',
        tag: 'select',
        labelText: 'State',
        options: [
          { value: 'KA-9876543210', text: 'Karnataka' },
          { value: 'TN-9876543210', text: 'Tamil Nadu' },
        ],
      }),
    ]);

    expect(report.fields[0]?.options).toEqual(['Karnataka', 'Tamil Nadu']);
    expect(JSON.stringify(report.fields)).not.toContain('9876543210');
  });

  it('never sends the URL of the page', () => {
    // Not in the plan's payload contract, and the single most identifying
    // thing available: which portals someone applies to is sensitive on its
    // own, and portal URLs carry application numbers.
    const report = redactFields([
      field({ ref: 'f1', nearbyText: `Return to https://portal.example.gov.in/apply?id=${CANARIES.applicationNo}` }),
    ]);

    const text = JSON.stringify(report.fields);
    expect(text).not.toContain('portal.example.gov.in');
    expect(text).not.toContain(CANARIES.applicationNo);
  });

  it('skips a field with nothing to say rather than spending tokens on it', () => {
    const report = redactFields([field({ ref: 'f1', selectors: ['div > input:nth-of-type(2)'], labelText: '' })]);
    expect(report.fields).toEqual([]);
  });

  it('caps every string, so one enormous page cannot become one enormous prompt', () => {
    const report = redactFields([
      field({
        ref: 'f1',
        labelText: 'L'.repeat(5_000),
        nearbyText: 'N'.repeat(5_000),
        tag: 'select',
        options: Array.from({ length: 500 }, (_, i) => ({ value: `${i}`, text: 'O'.repeat(500) })),
      }),
    ]);

    const out = report.fields[0]!;
    expect(out.label.length).toBeLessThanOrEqual(120);
    expect(out.nearby!.length).toBeLessThanOrEqual(200);
    expect(out.options!.length).toBeLessThanOrEqual(20);
    expect(out.options!.every((o) => o.length <= 40)).toBe(true);
  });
});

describe('scrubbing values out of page text', () => {
  it.each([
    ['an Aadhaar', CANARIES.aadhaar],
    ['a spaced Aadhaar', CANARIES.aadhaarSpaced],
    ['a PAN', CANARIES.pan],
    ['an email', CANARIES.email],
    ['a mobile number', CANARIES.mobile],
    ['an account number', CANARIES.account],
    ['an IFSC code', CANARIES.ifsc],
    ['a date of birth', CANARIES.dob],
    ['an application number', CANARIES.applicationNo],
  ])('removes %s', (_name, value) => {
    const result = scrubText(`Your details: ${value} — please confirm`);
    expect(result.text).not.toContain(value);
  });

  it('keeps the label words that make a field matchable', () => {
    // The whole point: the model must learn the field is *for* an Aadhaar
    // without learning what the Aadhaar is.
    const result = scrubText(`Aadhaar Number (UID): ${CANARIES.aadhaar}`);

    expect(result.text).toContain('Aadhaar');
    expect(result.text).toContain('UID');
    expect(result.text).not.toContain(CANARIES.aadhaar);
  });

  it.each([
    'Step 2 of 3',
    'PIN Code (6 digits)',
    'Enter 10 digit mobile number',
    'Class 12 marks',
    'Address Line 1',
    'Percentage in Class 10',
  ])('leaves the instructional text %s intact', (text) => {
    expect(scrubText(text).text).toBe(text);
  });

  it('reports what kind of thing it removed, never what it was', () => {
    const result = scrubText(`${CANARIES.email} and ${CANARIES.pan}`);

    expect(result.hits.email).toBe(1);
    expect(JSON.stringify(result.hits)).not.toContain(CANARIES.email);
    expect(JSON.stringify(result.hits)).not.toContain(CANARIES.pan);
  });

  it('removes every occurrence, not just the first', () => {
    const result = scrubText(`${CANARIES.email} / ${CANARIES.email} / ${CANARIES.email}`);
    expect(result.text).not.toContain('@example.com');
    expect(result.hits.email).toBe(3);
  });

  it('scrubs a name-shaped identifier out of a field name', () => {
    const report = redactFields([
      field({ ref: 'f1', selectors: [`#user_${CANARIES.mobile}_name`], labelText: 'Name' }),
    ]);
    expect(JSON.stringify(report.fields)).not.toContain(CANARIES.mobile);
  });
});

describe('THE LEAK SUITE — canaries planted in a real page', () => {
  /**
   * A portal the user has already been through: their name in the heading,
   * their Aadhaar shown for confirmation, values sitting in the inputs, and an
   * application number in the surrounding text. Everything here is what a real
   * half-completed government form looks like on the second visit.
   */
  const FILLED_PORTAL = `
    <h1>Welcome back, ${CANARIES.name}</h1>
    <p>Application ${CANARIES.applicationNo} — continue where you left off.</p>

    <fieldset>
      <legend>Personal Details — ${CANARIES.name}</legend>

      <label for="a">Candidate Name</label>
      <input id="a" name="txtName" value="${CANARIES.name}" />

      <label for="b">Aadhaar Number (${CANARIES.aadhaarSpaced} on file)</label>
      <input id="b" name="txtUID" value="${CANARIES.aadhaar}" placeholder="${CANARIES.aadhaar}" />

      <label for="c">PAN</label>
      <input id="c" name="txtPAN" value="${CANARIES.pan}" title="Registered as ${CANARIES.pan}" />

      <label for="d">Email ID</label>
      <input id="d" name="txtEmail" type="email" value="${CANARIES.email}" />

      <label for="e">Mobile</label>
      <input id="e" name="txtMobile" value="${CANARIES.mobile}" />

      <label for="f">Date of Birth</label>
      <input id="f" name="txtDOB" value="${CANARIES.dob}" />

      <label for="g">Bank Account Number</label>
      <input id="g" name="txtAcct" value="${CANARIES.account}" />

      <label for="h">IFSC</label>
      <input id="h" name="txtIFSC" value="${CANARIES.ifsc}" />

      <label for="i">State</label>
      <select id="i" name="ddlState">
        <option value="${CANARIES.account}">Karnataka</option>
        <option value="TN">Tamil Nadu</option>
      </select>
    </fieldset>
  `;

  function harvestedPayload(html: string): string {
    document.body.innerHTML = html;
    const result = harvest(document);
    return payloadText(result.fields);
  }

  it('leaks no value-shaped canary from a page that is full of them', () => {
    const payload = harvestedPayload(FILLED_PORTAL);

    for (const [name, canary] of Object.entries(CANARIES)) {
      if (name === 'name') continue; // see the test immediately below
      expect(payload, `canary "${name}" reached the payload`).not.toContain(canary);
    }
  });

  it('does NOT remove a person’s name — and that is why value-guard.ts exists', () => {
    // Recorded as a fact about this module rather than left as a surprise.
    // A name has no syntax: "Ravi Kumar Chandrasekaran" is indistinguishable
    // from "Personal Details" or "Tamil Nadu" to any pattern. The only thing
    // that knows it is a name is the vault, so the final pass happens in
    // `value-guard.ts`, which is allowed to read it. This module stays unable
    // to — that is the boundary, and it is worth more than this one case.
    //
    // If this assertion ever starts failing, do not simply delete it: work out
    // what changed, because a syntactic rule that eats names will also eat
    // labels.
    const payload = harvestedPayload(FILLED_PORTAL);
    expect(payload).toContain(CANARIES.name);
  });

  it('still describes the fields well enough to be matchable', () => {
    // A redaction layer that produced an empty payload would pass every leak
    // test and be useless. This is the counterweight.
    document.body.innerHTML = FILLED_PORTAL;
    const report = redactFields(harvest(document).fields);
    const payload = JSON.stringify(report.fields);

    expect(report.fields.length).toBeGreaterThanOrEqual(8);
    for (const word of ['Aadhaar', 'PAN', 'Email', 'Mobile', 'Bank', 'IFSC', 'Candidate']) {
      expect(payload, `the label word "${word}" should survive`).toContain(word);
    }
  });

  it('records that it removed things, so a silent no-op is visible', () => {
    document.body.innerHTML = FILLED_PORTAL;
    const report = redactFields(harvest(document).fields);

    expect(Object.keys(report.redacted).length).toBeGreaterThan(0);
  });

  it('leaks nothing across every fixture in the corpus', () => {
    // The plan's "run the matcher over all fixtures" half. These pages are not
    // seeded with canaries, so this asserts the weaker but still worthwhile
    // property: nothing value-shaped survives from any page we ship.
    const pages = import.meta.glob('../../fixtures/*/*.html', {
      query: '?raw',
      eager: true,
    }) as Record<string, { default: string }>;

    expect(Object.keys(pages).length).toBeGreaterThan(3);

    for (const [path, module] of Object.entries(pages)) {
      document.documentElement.innerHTML = module.default;
      const payload = payloadText(harvest(document).fields);

      // Nothing that looks like an identity number, an email, or a long
      // reference should survive from any fixture.
      expect(payload, `${path} leaked an email`).not.toMatch(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i);
      expect(payload, `${path} leaked a 12-digit number`).not.toMatch(/\d{12}/);
      expect(payload, `${path} leaked a PAN`).not.toMatch(/\b[A-Z]{5}\d{4}[A-Z]\b/);
    }
  });
});

describe('the module boundary — the guarantee behind the canaries', () => {
  it('imports nothing from the vault or the documents pipeline', () => {
    // The lint rule enforces this too; asserting it here means the guarantee
    // survives someone running the tests without the linter.
    const sources = import.meta.glob('./redaction.ts', { query: '?raw', eager: true }) as Record<
      string,
      { default: string }
    >;
    const source = Object.values(sources)[0]?.default ?? '';
    expect(source.length).toBeGreaterThan(500);

    expect(source).not.toMatch(/from '@\/vault\//);
    expect(source).not.toMatch(/from '@\/documents\//);
    expect(source).not.toMatch(/getAllFields|withKey|requireKey|decryptText/);
  });

  it('the payload type has no property that could hold a value', () => {
    // `RedactedField` is deliberately narrower than `FieldDescriptor`, so a
    // property added to the descriptor later does not silently start being
    // transmitted. This asserts the shape stays closed.
    const report = redactFields([
      field({ ref: 'f1', labelText: 'Name', selectors: ['#a', 'input[name="txtName"]'] }),
    ]);

    const keys = Object.keys(report.fields[0]!).sort();
    expect(keys).toEqual(['label', 'name', 'ref'].sort());
  });
});

describe('identifierOf', () => {
  it.each([
    [['#txtName', 'input[name="txtName"]'], 'txtName'],
    [['input[name="candidateName"]'], 'candidateName'],
    [['//label[.="Name"]/following::input[1]'], ''],
    [['div > input:nth-of-type(2)'], ''],
  ])('reads %s as "%s"', (selectors, expected) => {
    expect(identifierOf(field({ ref: 'f1', selectors }))).toBe(expected);
  });
});
