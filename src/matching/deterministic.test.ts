import { describe, expect, it } from 'vitest';
import { bandOf, matchField, matchForm, synonymEntries } from './deterministic';
import { isFieldKey, sensitivityOf, type FieldKey } from './taxonomy';
import { CONFIDENCE, type FieldDescriptor } from '@/shared/types';

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

  it('refuses a file input for a composed key that has no traits entry', () => {
    // "10th" and "marks" compose `education.class_10.marks_obtained`, a key
    // with no traits of its own — and the veto used to wave any such key
    // through, so a file box became a marks box. What a file box holds is
    // decided by the kind of key, not by whether its traits were written down.
    const result = matchField(field({ tag: 'file', labelText: 'Upload your 10th marks card' }));
    expect(result.key.startsWith('education.')).toBe(false);
  });

  it('reads the Karnataka "marks card" wording as the marksheet it is', () => {
    expect(matchField(field({ tag: 'file', labelText: 'Upload your 10th marks card' })).key).toBe(
      'doc.marksheet_10',
    );
    expect(matchField(field({ tag: 'file', labelText: 'SSLC Marks Card' })).key).toBe(
      'doc.marksheet_10',
    );
    expect(matchField(field({ tag: 'file', labelText: '2nd PUC Marks Card' })).key).toBe(
      'doc.marksheet_12',
    );
  });

  it('reads "passport size photo" as the photograph', () => {
    const result = matchField(field({ tag: 'file', labelText: 'Upload your recent passport size photo' }));
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

describe('address sections carry across the block beneath the heading', () => {
  const addr = (ref: string, labelText: string, nearbyText = ''): FieldDescriptor =>
    field({ ref, labelText, nearbyText, selectors: [`#${ref}`] });

  function keysFor(fields: FieldDescriptor[]): string[] {
    return matchForm(fields).map((m) => m.key);
  }

  it('gives the whole run the adjective only the first field carries', () => {
    // The Google Form shape: one heading per question, so "Current address"
    // labels the street field and nothing else says which address it is.
    const keys = keysFor([
      addr('a', 'Current address'),
      addr('b', 'City'),
      addr('c', 'PIN code'),
    ]);

    expect(keys).toEqual([
      'address.correspondence.line1',
      'address.correspondence.city',
      'address.correspondence.pincode',
    ]);
  });

  it('never assembles one address out of two sections', () => {
    // The regression this rule exists for. Splitting a block is worse than
    // choosing either section, because the result is a street from one address
    // and a PIN code from another — and it happens above the auto-fill bar.
    const results = matchForm([
      addr('a', 'Current address'),
      addr('b', 'City'),
      addr('c', 'PIN code'),
    ]);

    const sections = new Set(results.map((m) => m.key.split('.').slice(0, 2).join('.')));
    expect([...sections]).toEqual(['address.correspondence']);
  });

  it('keeps two labelled blocks apart', () => {
    const keys = keysFor([
      addr('a', 'Address Line 1', 'Permanent Address'),
      addr('b', 'City', 'Permanent Address'),
      addr('c', 'Address Line 1', 'Correspondence Address'),
      addr('d', 'City', 'Correspondence Address'),
    ]);

    expect(keys).toEqual([
      'address.permanent.line1',
      'address.permanent.city',
      'address.correspondence.line1',
      'address.correspondence.city',
    ]);
  });

  it('defaults to permanent when the form names no section at all', () => {
    const keys = keysFor([addr('a', 'Street address'), addr('b', 'City'), addr('c', 'PIN code')]);

    expect(keys).toEqual([
      'address.permanent.line1',
      'address.permanent.city',
      'address.permanent.pincode',
    ]);
  });

  it('stops carrying at the end of the block', () => {
    // "Permanent Account Number" is a PAN field, not a section heading, and the
    // address questions after it must not inherit anything from before it.
    const keys = keysFor([
      addr('a', 'Correspondence address'),
      addr('b', 'City'),
      field({ ref: 'c', labelText: 'Permanent Account Number', selectors: ['#c'], maxLength: 10 }),
      addr('d', 'Address Line 1'),
      addr('e', 'PIN code'),
    ]);

    expect(keys).toEqual([
      'address.correspondence.line1',
      'address.correspondence.city',
      'id.pan',
      'address.permanent.line1',
      'address.permanent.pincode',
    ]);
  });

  it('reads a lone field on its own text, with no block to consult', () => {
    // `matchField` is called directly by the teach flow, one field at a time.
    expect(matchField(addr('a', 'Correspondence address')).key).toBe(
      'address.correspondence.line1',
    );
  });
});

/**
 * Two mis-fills from one live Microsoft Forms campus-drive form.
 *
 * Both are the same class of fault: a plausible-looking key of the *wrong kind*
 * winning a field, and filling at a confidence high enough to be written.
 * §6.4 rates a confident mis-match above a miss in severity, so the fix in both
 * cases is to leave the box alone rather than to guess better.
 */
describe('a key of the wrong kind must not win a field', () => {
  function field(ref: string, labelText: string): FieldDescriptor {
    return {
      ref,
      tag: 'input',
      type: 'text',
      name: '',
      id: '',
      labelText,
      labelSource: 'aria-labelledby',
      placeholder: '',
      nearbyText: '',
      required: true,
      visible: true,
      selectors: ['input'],
    } as unknown as FieldDescriptor;
  }

  const personal = '3. Email ID (Personal Email address) Single line text.';
  const official = '4. Email ID (Official /college Email adderess) Single line text.';

  it('never answers an email box with an institution name', () => {
    // The reported fill: "M S Ramaiah University of Applied Sciences" was
    // written into the official-email box, because de-duplication handed the
    // second email field its runner-up and the runner-up was a college name.
    const results = matchForm([field('r3', personal), field('r4', official)]);
    const second = results.find((r) => r.fieldRef === 'r4')!;

    expect(second.key).not.toBe('education[].institution');
  });

  it('keeps the first email field correct', () => {
    const results = matchForm([field('r3', personal), field('r4', official)]);
    expect(results.find((r) => r.fieldRef === 'r3')!.key).toBe('contact.email');
  });

  it('rules out non-email keys even when the label names one', () => {
    // "college" is a qualifier on an email box, not a change of subject - and
    // since the frame layer, a qualifier with a key of its own.
    const alone = matchField(field('r', 'College Email ID'));
    expect(alone.key).toBe('contact.official_email');
  });

  it('does not offer an address line for a labelled email box', () => {
    const alone = matchField(field('r', 'Email ID (Personal Email address)'));
    expect(alone.rationale).not.toMatch(/address\.permanent\.line1/);
  });

  it('does not confidently call a bare "Branch" a bank branch', () => {
    /*
     * On a campus form "Branch" is the academic discipline, and there is no
     * taxonomy key for that yet — so the best available outcome is that a
     * bank's branch name never arrives unannounced. Dropping the bare synonym
     * takes it from 0.80 (written, unflagged) to below the auto-fill line,
     * where a human is asked to look.
     *
     * The complete fix is a key of its own; until then this is the safe half.
     */
    const alone = matchField(field('r', '5. Branch Single line text.'));
    expect(alone.confidence).toBeLessThan(CONFIDENCE.AUTO_FILL);
  });

  it('still recognises a branch that says which kind it is', () => {
    expect(matchField(field('r', 'Bank Branch')).key).toBe('bank.branch');
    expect(matchField(field('r', 'Branch Name')).key).toBe('bank.branch');
  });
});

/**
 * The three-layer profile (Layers 1–3).
 *
 * Layer 2's seven qualification blocks share their field segments with the
 * generic `education[]` block, so a level named anywhere in a label retargets
 * the generic match onto the right block. That is the whole mechanism, and
 * these are the cases that decide whether it is worth having.
 */
describe('qualification levels', () => {
  let seq = 0;
  function field(labelText: string, nearbyText = ''): FieldDescriptor {
    return {
      // Distinct: `matchForm` keys its results by ref, so a shared one would
      // silently collapse three fields into one.
      ref: `r${(seq += 1)}`,
      tag: 'input',
      type: 'text',
      labelText,
      labelSource: 'label',
      placeholder: '',
      nearbyText,
      required: true,
      visible: true,
      selectors: ['input'],
    } as unknown as FieldDescriptor;
  }

  it.each([
    ['10th Percentage', 'education.class_10.percentage'],
    ['SSLC Roll Number', 'education.class_10.roll_number'],
    ['Class 12 Percentage', 'education.class_12.percentage'],
    ['HSC Board', 'education.class_12.board_or_university'],
    ['Diploma College Name', 'education.diploma.institution'],
    ['B.Tech CGPA', 'education.undergraduate.cgpa'],
    ['UG Year of Passing', 'education.undergraduate.year_of_passing'],
    ['PG University', 'education.postgraduate.board_or_university'],
    ['PhD Year of Passing', 'education.phd.year_of_passing'],
  ])('reads %s as %s', (label, expected) => {
    expect(matchField(field(label)).key).toBe(expected);
  });

  it('keeps an unqualified label on the generic block', () => {
    // No level named, so no level is invented.
    expect(matchField(field('Percentage')).key).toBe('education[].percentage');
  });

  it('does not let "graduation" swallow a postgraduate field', () => {
    // "Post Graduation" contains "graduation"; order in EDUCATION_LEVELS is
    // what stops the undergraduate pattern claiming it.
    expect(matchField(field('Post Graduation Percentage')).key).toBe(
      'education.postgraduate.percentage',
    );
  });

  it('fills three separate percentage boxes from three separate keys', () => {
    // The failure this replaces: all three matched `education[].percentage`,
    // and a repeatable key is exempt from the duplicate check, so one stored
    // value would have been written into all three.
    const keys = matchForm([
      field('10th Percentage'),
      field('12th Percentage'),
      field('Degree Percentage'),
    ]).map((r) => r.key);

    expect(new Set(keys).size).toBe(3);
  });
});

describe('branch, which is two different fields', () => {
  function field(labelText: string, nearbyText = '', selectors = ['input']): FieldDescriptor {
    return {
      ref: 'r',
      tag: 'input',
      type: 'text',
      labelText,
      labelSource: 'label',
      placeholder: '',
      nearbyText,
      required: true,
      visible: true,
      selectors,
    } as unknown as FieldDescriptor;
  }

  it('is the academic one next to education fields', () => {
    expect(matchField(field('Branch', 'Roll No. Course CGPA')).key).toBe('education[].branch');
  });

  it('is the bank one next to bank fields', () => {
    expect(matchField(field('Branch', 'Bank Name IFSC Account Number')).key).toBe('bank.branch');
  });

  it('takes the hint from the control name when the text is silent', () => {
    expect(matchField(field('Branch', '', ['#txtBankBranch'])).key).toBe('bank.branch');
  });
});

describe('eligibility and emergency contact', () => {
  function field(labelText: string): FieldDescriptor {
    return {
      ref: 'r',
      tag: 'input',
      type: 'text',
      labelText,
      labelSource: 'label',
      placeholder: '',
      nearbyText: '',
      required: true,
      visible: true,
      selectors: ['input'],
    } as unknown as FieldDescriptor;
  }

  it.each([
    ['Caste', 'eligibility.caste'],
    ['EWS', 'eligibility.ews'],
    ['UDID Number', 'eligibility.udid'],
    ['Domicile State', 'eligibility.domicile_state'],
    ['Type of Disability', 'eligibility.disability_type'],
    ['Minority Community', 'eligibility.minority'],
    ['Ex Serviceman', 'eligibility.ex_serviceman'],
    ['Age Relaxation', 'eligibility.age_relaxation'],
    ['Emergency Contact Name', 'emergency.name'],
    ['Emergency Contact Number', 'emergency.mobile'],
  ])('reads %s as %s', (label, expected) => {
    expect(matchField(field(label)).key).toBe(expected);
  });

  it('keeps a UDID out of the auto-fill band, like every other government id', () => {
    expect(sensitivityOf('eligibility.udid')).toBe('high');
  });
});

/**
 * The semantic frame, end to end (`frame.ts` composed into `matchField`).
 *
 * Before it, every label here that names someone other than the applicant
 * matched the applicant's own key at 0.80 — the band that gets written — so a
 * student's own phone number went into the box for their mother's.
 */
describe('whose value, which one: the frame, end to end', () => {
  function field(labelText: string): FieldDescriptor {
    return {
      ref: 'r',
      tag: 'input',
      type: 'text',
      labelText,
      labelSource: 'label',
      placeholder: '',
      nearbyText: '',
      required: true,
      visible: true,
      selectors: ['input'],
    } as unknown as FieldDescriptor;
  }

  it.each([
    ["Mother's Mobile Number", 'family.mother_mobile'],
    ["Father's Email ID", 'family.father_email'],
    ['Guardian Mobile', 'family.guardian_mobile'],
    ['Official Email', 'contact.official_email'],
    ['Alternate Email ID', 'contact.alt_email'],
    ['Confirm Email', 'contact.email'],
    ['Mother Tongue', 'identity.mother_tongue'],
  ])('%s → %s', (label, expected) => {
    expect(matchField(field(label)).key).toBe(expected);
  });

  it.each(["Parent's Email", "Father's Date of Birth", "Father's Aadhaar Number"])(
    'leaves "%s" blank rather than filling the applicant’s own',
    (label) => {
      const result = matchField(field(label));
      expect(result.key).toBe('unknown');
      expect(result.rationale).toMatch(/left for you to fill/);
    },
  );
});

/**
 * A key naming one family member, meeting a box about another (`frame.ts`).
 *
 * The dictionary's occupation phrases are the father's, so "Mother's
 * Occupation" matched `family.father_occupation` at 0.63 — inside the band
 * that is written, putting the father's occupation in the mother's box. There
 * is no saved occupation for a mother, so the honest answer is blank.
 */
describe('a key for a different family member', () => {
  function field(labelText: string): FieldDescriptor {
    return {
      ref: 'r',
      tag: 'input',
      type: 'text',
      labelText,
      labelSource: 'label',
      placeholder: '',
      nearbyText: '',
      required: true,
      visible: true,
      selectors: ['input'],
    } as unknown as FieldDescriptor;
  }

  it('does not give the mother the father’s occupation', () => {
    const result = matchField(field("Mother's Occupation"));
    expect(result.key).toBe('unknown');
    expect(result.rationale).toMatch(/your mother/);
  });

  it('keeps a key the label itself names, when it names two people', () => {
    // "Father or Guardian Name" is an exact guardian synonym. Naming the father
    // as well must not turn the guardian reading into a stand-in for him.
    expect(matchField(field('Father or Guardian Name')).key).toBe('family.guardian_name');
  });

  it('still reads a bare Occupation as the father’s, as the dictionary does', () => {
    expect(matchField(field('Occupation')).key).toBe('family.father_occupation');
  });
});

describe('the taluk, which every Karnataka portal asks for', () => {
  /*
   * A key added when an Aadhaar letter turned out to carry it ("Sub District")
   * and nothing in the vault could hold it. It sits between the village and the
   * district and is neither, so the test that matters is the one that keeps it
   * from being answered with either.
   */
  const matchOf = (labelText: string) => matchField(field({ labelText }));

  it('matches the words a form uses for it', () => {
    for (const label of ['Taluk', 'Taluka', 'Tehsil', 'Taluk / Tehsil', 'Mandal']) {
      expect(matchOf(label).key, label).toBe('address.permanent.taluk');
    }
  });

  it('is confident enough to fill without being asked twice', () => {
    expect(matchOf('Taluk').confidence).toBeGreaterThanOrEqual(CONFIDENCE.AUTO_FILL);
  });

  it('does not take the district’s box, nor the village’s', () => {
    expect(matchOf('District').key).toBe('address.permanent.district');
    expect(matchOf('Village / Town / City').key).toBe('address.permanent.city');
  });

  it('keeps the correspondence taluk separate from the permanent one', () => {
    expect(matchOf('Correspondence Taluk').key).toBe('address.correspondence.taluk');
  });
});

describe('each subject’s own marks', () => {
  /*
   * An entrance application asks for Physics, Chemistry and Mathematics by
   * name. The vault holds them per subject, read off the marks card; these are
   * the words that find them, and the ones that must not.
   */
  const matchOf = (labelText: string, nearbyText = '') =>
    matchField(field({ labelText, nearbyText }));

  it('matches a subject named with its marks', () => {
    expect(matchOf('Physics Marks').key).toBe('education[].marks_physics');
    expect(matchOf('Marks obtained in Chemistry').key).toBe('education[].marks_chemistry');
    expect(matchOf('Maths Marks').key).toBe('education[].marks_mathematics');
    expect(matchOf('Biology Marks Obtained').key).toBe('education[].marks_biology');
    expect(matchOf('English Marks').key).toBe('education[].marks_english');
  });

  it('moves onto the qualification the form names', () => {
    expect(matchOf('Physics Marks', '2nd PUC / Class 12 Details').key).toBe(
      'education.class_12.marks_physics',
    );
    expect(matchOf('Mathematics Marks', 'SSLC / Class 10 Details').key).toBe(
      'education.class_10.marks_mathematics',
    );
  });

  it('never files Social Science as Science, nor Computer Science', () => {
    expect(matchOf('Social Science Marks').key).toBe('education[].marks_social_science');
    expect(matchOf('Computer Science Marks').key).toBe('education[].marks_computer_science');
    expect(matchOf('Science Marks').key).toBe('education[].marks_science');
  });

  it('holds one language, and it is the first', () => {
    expect(matchOf('First Language Marks').key).toBe('education[].marks_language');
    expect(matchOf('Marks obtained in First Language').key).toBe('education[].marks_language');
  });

  it('never answers a second or third language with the first', () => {
    // An SSLC card has three languages and the vault has a box for one. Which
    // of them a form means by "Kannada" or plain "Language" depends on what
    // the person sat, so those are left for the person too.
    for (const label of [
      'Second Language Marks',
      'Third Language Marks',
      'Language Marks',
      'Kannada Marks',
      'Hindi Marks',
    ]) {
      expect(bandOf(matchOf(label)), label).toBe('unmapped');
    }
  });

  it('leaves the total alone', () => {
    // "Marks obtained" is the total, and must not become any one subject.
    expect(matchOf('Marks Obtained').key).toBe('education[].marks_obtained');
    expect(matchOf('Total Marks Obtained').key).toBe('education[].marks_obtained');
    expect(matchOf('Maximum Marks').key).toBe('education[].max_marks');
  });

  it('does not fill a box that names a subject and nothing else', () => {
    // "Physics" alone is as likely a box to tick as a mark to type.
    for (const label of ['Physics', 'Chemistry', 'Mathematics', 'English']) {
      expect(bandOf(matchOf(label)), label).toBe('unmapped');
    }
  });
});

describe('partial matches that are one observation', () => {
  /*
   * Several phrases of one key partly matching a label through the same word
   * used to corroborate each other into the fill band. These are the fourth
   * portal's own traps, and the one label that is rightly found that way.
   */
  const matchOf = (labelText: string) => matchField(field({ labelText }));

  it('does not fill an office box because one word of it is in the dictionary', () => {
    for (const label of ['Ward Inspector’s Remarks', 'Licence Serial (allotted by this office)']) {
      expect(bandOf(matchOf(label)), label).toBe('unmapped');
    }
  });

  it('still fills a label found through two different words of it', () => {
    const match = matchOf('Appellation of the Applicant (in full, as per record)');
    expect(match.key).toBe('identity.full_name');
    expect(bandOf(match)).toBe('fill-and-flag');
  });

  it('leaves a key the label names outright exactly as sure as it was', () => {
    // "e mail" is contained whole; its longer phrases still add their weight.
    const match = matchOf('Electronic Mail Identifier');
    expect(match.key).toBe('contact.email');
    expect(bandOf(match)).toBe('auto-fill');
  });
});

describe('a Karnataka register number', () => {
  /*
   * Karnataka's SSLC and PUC cards print "Register Number" — "Register No." on
   * the PUC card — and an entrance form asks for it in the same words: "2nd PUC
   * Register Number". The dictionary knew only "registration number", and the
   * box was left empty on a form the vault could answer.
   */
  const matchOf = (labelText: string, nearbyText = '') => matchField(field({ labelText, nearbyText }));

  it('reads "Register Number" as the registration number the card prints', () => {
    expect(matchOf('Register Number').key).toBe('education[].registration_number');
    expect(matchOf('Register No.').key).toBe('education[].registration_number');
  });

  it('takes the qualification the label or its heading names', () => {
    expect(matchOf('2nd PUC Register Number', '2nd PUC / Class 12 Details').key).toBe(
      'education.class_12.registration_number',
    );
    expect(matchOf('SSLC Register Number', 'SSLC / Class 10 Details').key).toBe(
      'education.class_10.registration_number',
    );
  });

  it('leaves a registered mobile number, and an entrance registration, where they were', () => {
    expect(matchOf('Registered Mobile Number').key).toBe('contact.mobile');
    expect(matchOf('CET Registration Number').key).toBe('entrance.registration_number');
  });
});

describe('a field of study, asked the way a survey asks it', () => {
  /*
   * Google Forms questions are sentences: "What is your current field of study
   * or major?" It is the branch the vault already holds — and a dropdown of
   * families ("Computer Science / IT") that the option chooser then picks from.
   */
  const matchOf = (labelText: string) => matchField(field({ labelText, tag: 'select' }));

  it('reads "field of study" and "major subject" as the branch', () => {
    expect(matchOf('What is your current field of study or major?').key).toBe('education[].branch');
    expect(matchOf('Field of Study').key).toBe('education[].branch');
    expect(matchOf('Major Subject').key).toBe('education[].branch');
    expect(matchOf('Area of study').key).toBe('education[].branch');
  });

  it('never fills an age question with a branch — so bare "major" is not a synonym', () => {
    expect(bandOf(matchOf('Are you a major (18 years or above)?'))).toBe('unmapped');
  });
});

describe('a number a form offers as a list', () => {
  /*
   * Income is asked in bands ("Below 1 Lakh", "1 – 2.5 Lakh"), and the year of
   * passing from a list of years — both as dropdowns, everywhere. The veto that
   * keeps an Aadhaar number off a dropdown kept these off too, so the question
   * was left blank on every form that asked it that way.
   */
  const asked = (labelText: string, texts: string[], tag: 'select' | 'radio-group' = 'select') =>
    matchField(field({ labelText, tag, options: texts.map((text) => ({ value: text, text })) }));

  it('matches an income asked in bands', () => {
    expect(asked('Annual Family Income', ['Select', 'Up to 1 Lakh', '1 Lakh to 2.5 Lakh', 'Above 2.5 Lakh']).key).toBe(
      'family.annual_income',
    );
  });

  it('matches a year of passing chosen from a list', () => {
    expect(asked('Year of Passing', ['Select', '2022', '2023', '2024']).key).toBe('education[].year_of_passing');
  });

  it('still keeps an identifier off a dropdown', () => {
    expect(asked('Aadhaar Number', ['Select', 'Yes', 'No']).key).not.toBe('id.aadhaar');
    expect(asked('PIN Code', ['Select', 'Urban', 'Rural']).key).not.toBe('address.permanent.pincode');
  });
});

describe('the box for a question’s "Other"', () => {
  /*
   * "Religion: Hindu / Muslim / Christian / Others", then a box "Religion, if
   * others". The box matched religion too — so a Hindu applicant had "Hindu"
   * typed into the box for other religions. It is the question's own "Other"
   * box: written when the answer is "Other", by the choice itself.
   */
  const religion = field({
    ref: 'g',
    tag: 'radio-group',
    labelText: 'Religion',
    options: ['Hindu', 'Muslim', 'Christian', 'Others'].map((text) => ({ value: text, text })),
  });

  it('is left to the question before it, not matched as the key', () => {
    const box = field({ ref: 'b', labelText: 'Religion, if others' });
    const [group, other] = matchForm([religion, box]);
    expect(group!.key).toBe('identity.religion');
    expect(other!.key).toBe('unknown');
    expect(other!.rationale).toMatch(/Other/);
  });

  it('is still matched when the question before it offers no "Other"', () => {
    const closed = { ...religion, options: religion.options!.slice(0, 3) };
    const box = field({ ref: 'b', labelText: 'Religion, if others' });
    expect(matchForm([closed, box])[1]!.key).toBe('identity.religion');
  });

  it('leaves a box that only follows a choice question alone', () => {
    const box = field({ ref: 'b', labelText: 'Father’s Name' });
    expect(matchForm([religion, box])[1]!.key).toBe('family.father_name');
  });
});

describe('a name asked for in the applicant’s own language', () => {
  /*
   * Central and state forms ask for the name twice: in English, and in Hindi
   * or the state's language — "Name in Hindi", "Candidate's Name in Regional
   * Language". The reader now reads the second from a Hindi, Telugu or Tamil
   * document; these questions have to find it, and the English ones must not.
   */
  const matchOf = (labelText: string) => matchField(field({ labelText }));

  it('reads "Name in Hindi" and its kin as the name in the applicant’s language', () => {
    for (const label of [
      'Name in Hindi',
      'Candidate Name in Hindi',
      'Name in Regional Language',
      'Applicant’s Name in Local Language',
      'Name in Devanagari script',
      'नाम (हिंदी में)',
    ]) {
      expect(matchOf(label).key, label).toBe('identity.full_name_local');
    }
  });

  it('reads the parents’ names asked in Hindi the same way', () => {
    expect(matchOf("Father's Name in Hindi").key).toBe('family.father_name_local');
    expect(matchOf("Mother's Name in Regional Language").key).toBe('family.mother_name_local');
  });

  it('leaves the English questions with the English name', () => {
    expect(matchOf('Name in English').key).toBe('identity.full_name');
    expect(matchOf('Full Name (as per Class 10 certificate)').key).toBe('identity.full_name');
    expect(matchOf("Father's Name").key).toBe('family.father_name');
  });
});

describe('a form that asks for the name in two languages', () => {
  /*
   * "Name in Hindi" and "Name in Kannada" on one form both ask for the name in
   * the applicant's own language. The second used to be re-matched as a
   * duplicate — to its next best key, the English name — and the English
   * spelling was typed into the box for Kannada. Each keeps its key; which of
   * them the vault's spelling answers is the fill's decision, by script
   * (`fill-service.ts` → `buildWrites`).
   */
  it('keeps every language’s name question on the name in the applicant’s language', () => {
    const fields = [
      field({ ref: 'en', labelText: 'Name (in English)' }),
      field({ ref: 'hi', labelText: 'Name in Hindi' }),
      field({ ref: 'kn', labelText: 'Name in Kannada' }),
    ];
    expect(matchForm(fields).map((match) => match.key)).toEqual([
      'identity.full_name',
      'identity.full_name_local',
      'identity.full_name_local',
    ]);
  });
});

describe('what a grade card answers on a form', () => {
  /*
   * Placement and scholarship forms ask a degree student for the SGPA of the
   * last semester, the number of backlogs, and the USN — the University Seat
   * Number a Karnataka university registers its students by. The table reader
   * now reads all three off a semester grade card.
   */
  const matchOf = (labelText: string) => matchField(field({ labelText }));

  it('reads SGPA questions as the SGPA', () => {
    for (const label of ['SGPA', 'Last Semester SGPA', 'Semester Grade Point Average', 'SGPA of previous semester']) {
      expect(matchOf(label).key, label).toBe('education[].sgpa');
    }
  });

  it('keeps CGPA the CGPA', () => {
    expect(matchOf('CGPA').key).toBe('education[].cgpa');
  });

  it('reads backlog questions as the backlogs', () => {
    for (const label of ['Number of Backlogs', 'Active Backlogs', 'Current Backlogs', 'Standing Arrears']) {
      expect(matchOf(label).key, label).toBe('education[].backlogs');
    }
  });

  it('reads the USN as the registration number', () => {
    for (const label of ['USN', 'University Seat Number']) {
      expect(matchOf(label).key, label).toBe('education[].registration_number');
    }
  });
});
