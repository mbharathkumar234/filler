import { describe, expect, it } from 'vitest';
import { bandOf, matchField, matchForm, synonymEntries } from './deterministic';
import { isFieldKey, type FieldKey } from './taxonomy';
import type { FieldDescriptor } from '@/shared/types';

/**
 * Unit behaviour of the matcher. The *acceptance* numbers (>=70% at >=0.85,
 * zero high-confidence mis-matches) are measured separately in `eval.test.ts`
 * over held-out fixtures, because a rule scored against the example it was
 * written for proves nothing.
 */
function field(overrides: Partial<FieldDescriptor> = {}): FieldDescriptor {
  return {
    ref: 'f0',
    selectors: ['#x'],
    tag: 'input',
    labelText: '',
    nearbyText: '',
    required: false,
    frameId: 0,
    visible: true,
    enabled: true,
    ...overrides,
  };
}

describe('the synonym dictionary', () => {
  it('only references keys that exist in the taxonomy', () => {
    for (const entry of synonymEntries()) {
      expect(isFieldKey(entry.key), entry.key).toBe(true);
    }
  });

  it('has no empty phrases', () => {
    for (const entry of synonymEntries()) {
      expect(entry.tokens.length, entry.phrase).toBeGreaterThan(0);
    }
  });

  it('carries Devanagari entries for government portals', () => {
    const devanagari = synonymEntries().filter((e) => /[ऀ-ॿ]/.test(e.phrase));
    expect(devanagari.length).toBeGreaterThan(20);
  });

  it('does not give one phrase to two different keys', () => {
    const byCanonical = new Map<string, Set<string>>();
    for (const entry of synonymEntries()) {
      const set = byCanonical.get(entry.canonical) ?? new Set();
      set.add(entry.key);
      byCanonical.set(entry.canonical, set);
    }
    const collisions = [...byCanonical.entries()]
      .filter(([, keys]) => keys.size > 1)
      .map(([phrase, keys]) => `"${phrase}" → ${[...keys].join(', ')}`);
    expect(collisions).toEqual([]);
  });
});

describe('autocomplete — the strongest signal', () => {
  it.each([
    ['given-name', 'identity.given_name'],
    ['family-name', 'identity.surname'],
    ['email', 'contact.email'],
    ['postal-code', 'address.permanent.pincode'],
    ['bday', 'identity.dob'],
  ])('maps autocomplete="%s" to %s', (auto, key) => {
    const result = matchField(field({ autocomplete: auto, labelText: 'Something Vague' }));
    expect(result.key).toBe(key);
    expect(result.confidence).toBeGreaterThanOrEqual(0.85);
  });

  it('reads the section-prefixed form', () => {
    expect(matchField(field({ autocomplete: 'shipping address-line1' })).key).toBe(
      'address.permanent.line1',
    );
  });

  it('ignores autocomplete="off"', () => {
    const result = matchField(field({ autocomplete: 'off', labelText: 'Mystery' }));
    expect(result.key).toBe('unknown');
  });
});

describe('label matching', () => {
  it.each([
    ["Father's Name", 'family.father_name'],
    ['Date of Birth', 'identity.dob'],
    ['Email ID', 'contact.email'],
    ['PIN Code', 'address.permanent.pincode'],
    ['Aadhaar Number', 'id.aadhaar'],
    ['IFSC Code', 'bank.ifsc'],
    ['Year of Passing', 'education[].year_of_passing'],
  ])('maps "%s" to %s at auto-fill confidence', (label, key) => {
    const result = matchField(field({ labelText: label }));
    expect(result.key).toBe(key);
    expect(bandOf(result)).toBe('auto-fill');
  });

  it('matches a Hindi label', () => {
    expect(matchField(field({ labelText: 'पिता का नाम' })).key).toBe('family.father_name');
  });

  it('matches either half of a bilingual label', () => {
    const result = matchField(field({ labelText: "पिता का नाम / Father's Name" }));
    expect(result.key).toBe('family.father_name');
    expect(bandOf(result)).toBe('auto-fill');
  });

  it('matches a label with extra words around the synonym', () => {
    const result = matchField(field({ labelText: 'Please enter your Mobile Number here' }));
    expect(result.key).toBe('contact.mobile');
  });

  it('is insensitive to word order', () => {
    expect(matchField(field({ labelText: 'Name of Father' })).key).toBe('family.father_name');
  });

  it('leaves an unrecognisable label unmapped rather than guessing', () => {
    // "Code" alone must not drag this onto PIN Code or IFSC Code.
    const result = matchField(field({ labelText: 'Reference Code XJ-9' }));
    expect(bandOf(result)).toBe('unmapped');
  });

  it('does not match on a generic word alone', () => {
    for (const label of ['Batch Number', 'Application Code', 'Record Type']) {
      expect(bandOf(matchField(field({ labelText: label }))), label).toBe('unmapped');
    }
  });

  it('distinguishes address line 1 from line 2', () => {
    expect(matchField(field({ labelText: 'Address Line 1' })).key).toBe(
      'address.permanent.line1',
    );
    expect(matchField(field({ labelText: 'Address Line 2' })).key).toBe(
      'address.permanent.line2',
    );
  });
});

describe('name/id token heuristics', () => {
  it.each([
    ['txtFatherName', 'family.father_name'],
    ['ddlState', 'address.permanent.state'],
    ['hdnPan', 'id.pan'],
    ['txt_mobile_number', 'contact.mobile'],
  ])('reads %s as %s', (name, key) => {
    const result = matchField(field({ selectors: [`input[name="${name}"]`] }));
    expect(result.key).toBe(key);
  });

  it('scores below a label match, since names are a weaker signal', () => {
    const byLabel = matchField(field({ labelText: "Father's Name" }));
    const byName = matchField(field({ selectors: ['input[name="txtFatherName"]'] }));
    expect(byName.confidence).toBeLessThan(byLabel.confidence);
  });
});

describe('option-set matching', () => {
  it('recognises a state dropdown from its options alone', () => {
    const states = [
      'Andhra Pradesh', 'Bihar', 'Gujarat', 'Karnataka', 'Kerala',
      'Maharashtra', 'Punjab', 'Rajasthan', 'Tamil Nadu', 'Telangana',
    ];
    const result = matchField(
      field({
        tag: 'select',
        labelText: 'Select from list',
        options: states.map((s) => ({ value: s, text: s })),
      }),
    );
    expect(result.key).toBe('address.permanent.state');
    expect(result.rationale).toMatch(/options include/);
  });

  it('recognises a gender radio group', () => {
    const result = matchField(
      field({
        tag: 'radio-group',
        labelText: '',
        options: [
          { value: 'M', text: 'Male' },
          { value: 'F', text: 'Female' },
          { value: 'T', text: 'Transgender' },
        ],
      }),
    );
    expect(result.key).toBe('identity.gender');
  });

  it('does not fire on a short unrelated option list', () => {
    const result = matchField(
      field({
        tag: 'select',
        labelText: 'Preference',
        options: [
          { value: '1', text: 'Yes' },
          { value: '2', text: 'No' },
        ],
      }),
    );
    expect(result.key).toBe('unknown');
  });
});

describe('the traits veto — the zero-mis-match guard', () => {
  it('refuses to call a 10-character numeric box a full name', () => {
    const result = matchField(
      field({ labelText: 'Name', maxLength: 10, pattern: '[0-9]{10}' }),
    );
    expect(result.key).not.toBe('identity.full_name');
  });

  it('refuses a file input for a text key', () => {
    const result = matchField(field({ tag: 'file', labelText: "Father's Name" }));
    expect(result.key).toBe('unknown');
    expect(result.rationale).toMatch(/file upload/i);
  });

  it('refuses a text input for a document key', () => {
    const result = matchField(field({ tag: 'input', labelText: 'Upload Photograph' }));
    expect(result.key).toBe('unknown');
  });

  it('accepts a file input for a document key', () => {
    const result = matchField(field({ tag: 'file', labelText: 'Upload Photograph' }));
    expect(result.key).toBe('doc.photo');
  });

  it('refuses Aadhaar in a field too short to hold it', () => {
    const result = matchField(field({ labelText: 'Aadhaar Number', maxLength: 6 }));
    expect(result.key).toBe('unknown');
    expect(result.rationale).toMatch(/12|caps at/i);
  });

  it('allows Aadhaar in a field sized for it', () => {
    expect(matchField(field({ labelText: 'Aadhaar Number', maxLength: 12 })).key).toBe(
      'id.aadhaar',
    );
  });

  it('refuses a date-typed field for a free-text key', () => {
    const result = matchField(field({ type: 'date', labelText: 'Full Name' }));
    expect(result.key).not.toBe('identity.full_name');
  });

  it('explains the veto rather than going silently unknown', () => {
    const result = matchField(field({ tag: 'file', labelText: 'Email ID' }));
    expect(result.rationale).not.toBe('No rule matched this field.');
  });
});

describe('address section context', () => {
  it('routes an address under a correspondence heading to the right key', () => {
    const result = matchField(
      field({ labelText: 'Address Line 1', nearbyText: 'Correspondence Address' }),
    );
    expect(result.key).toBe('address.correspondence.line1');
  });

  it('routes the same label under a permanent heading to the permanent key', () => {
    const result = matchField(
      field({ labelText: 'Address Line 1', nearbyText: 'Permanent Address' }),
    );
    expect(result.key).toBe('address.permanent.line1');
  });

  it('handles "Present Address" as correspondence', () => {
    const result = matchField(field({ labelText: 'PIN Code', nearbyText: 'Present Address' }));
    expect(result.key).toBe('address.correspondence.pincode');
  });

  it('defaults to permanent when no section says otherwise', () => {
    expect(matchField(field({ labelText: 'PIN Code' })).key).toBe(
      'address.permanent.pincode',
    );
  });
});

describe('confidence discipline', () => {
  it('caps a match below auto-fill when a second key is equally plausible', () => {
    // No exact synonym, and both "mother name" and "guardian name" are fully
    // contained in the label — a genuine tie, so a human should look.
    const result = matchField(field({ labelText: 'Mother or Guardian Name' }));
    expect(result.confidence).toBeLessThan(0.85);
    expect(result.rationale).toMatch(/also plausible/);
  });

  it('lets an exact synonym match win decisively over a partial one', () => {
    // "father or guardian name" is an exact synonym; the presence of the
    // weaker "father name" reading must not drag it into the ambiguity band.
    const result = matchField(field({ labelText: 'Father or Guardian Name' }));
    expect(result.key).toBe('family.guardian_name');
    expect(bandOf(result)).toBe('auto-fill');
  });

  it('caps a hidden field below auto-fill', () => {
    const result = matchField(field({ labelText: "Father's Name", visible: false }));
    expect(result.confidence).toBeLessThan(0.85);
    expect(result.rationale).toMatch(/not visible/);
  });

  it('caps a disabled field below auto-fill', () => {
    const result = matchField(field({ labelText: "Father's Name", enabled: false }));
    expect(result.confidence).toBeLessThan(0.85);
  });

  it('never reports confidence above 1 or below 0', () => {
    const labels = ['Email ID', 'Nonsense', 'पिता का नाम', '', 'Aadhaar'];
    for (const labelText of labels) {
      const result = matchField(field({ labelText }));
      expect(result.confidence).toBeGreaterThanOrEqual(0);
      expect(result.confidence).toBeLessThanOrEqual(1);
    }
  });

  it('always explains itself', () => {
    for (const labelText of ['Email ID', 'Nonsense', 'Aadhaar Number']) {
      expect(matchField(field({ labelText })).rationale.length).toBeGreaterThan(5);
    }
  });

  it('reports source as rule', () => {
    expect(matchField(field({ labelText: 'Email ID' })).source).toBe('rule');
  });
});

describe('bandOf', () => {
  it('splits at the plan’s thresholds', () => {
    const make = (confidence: number, key: FieldKey | 'unknown' = 'contact.email') => ({
      fieldRef: 'f0',
      key,
      confidence,
      rationale: '',
      source: 'rule' as const,
    });
    expect(bandOf(make(0.9))).toBe('auto-fill');
    expect(bandOf(make(0.85))).toBe('auto-fill');
    expect(bandOf(make(0.84))).toBe('fill-and-flag');
    expect(bandOf(make(0.5))).toBe('fill-and-flag');
    expect(bandOf(make(0.49))).toBe('unmapped');
    expect(bandOf(make(0.95, 'unknown'))).toBe('unmapped');
  });
});

describe('matchForm', () => {
  it('flags rather than auto-fills when two fields claim one key', () => {
    // A "Confirm Email" field genuinely holds the same value — so keep the
    // match, but never auto-fill it unreviewed.
    const results = matchForm([
      field({ ref: 'f0', labelText: 'Email ID' }),
      field({ ref: 'f1', labelText: 'Email Address' }),
    ]);
    const duplicated = results.filter((r) => r.key === 'contact.email');
    expect(duplicated).toHaveLength(2);
    expect(duplicated.filter((r) => bandOf(r) === 'auto-fill')).toHaveLength(1);
    expect(duplicated.some((r) => /another field/.test(r.rationale))).toBe(true);
  });

  it('lets a stronger field win a contested key', () => {
    const results = matchForm([
      field({ ref: 'f0', labelText: 'Name' }),
      field({ ref: 'f1', labelText: 'Full Name', autocomplete: 'name' }),
    ]);
    const strong = results.find((r) => r.fieldRef === 'f1');
    expect(strong?.key).toBe('identity.full_name');
  });

  it('allows a repeatable key across rows', () => {
    const results = matchForm([
      field({ ref: 'f0', labelText: 'Year of Passing', selectors: ['input[name="edu_year_1"]'] }),
      field({ ref: 'f1', labelText: 'Year of Passing', selectors: ['input[name="edu_year_2"]'] }),
    ]);
    expect(results.every((r) => r.key === 'education[].year_of_passing')).toBe(true);
  });

  it('returns one result per input field, in order', () => {
    const fields = [
      field({ ref: 'f0', labelText: 'Email ID' }),
      field({ ref: 'f1', labelText: 'Nonsense' }),
      field({ ref: 'f2', labelText: 'PIN Code' }),
    ];
    const results = matchForm(fields);
    expect(results.map((r) => r.fieldRef)).toEqual(['f0', 'f1', 'f2']);
  });
});
