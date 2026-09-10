import { describe, expect, it } from 'vitest';
import type { FieldDescriptor } from '@/shared/types';
import { compose, readFrame, unhousedReason, type LabelFrame } from './frame';
import type { FieldKey } from './taxonomy';

/**
 * The frame layer decides *whose* value, *which one* and *which qualification*
 * a box asks for. Its failure mode is not a miss — it is typing the applicant's
 * own phone number into the box for their mother's, at a confidence high
 * enough to be written. Every case below is one a real form asks.
 */

function field(labelText: string, extra: Partial<FieldDescriptor> = {}): FieldDescriptor {
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
    ...extra,
  } as unknown as FieldDescriptor;
}

function frame(overrides: Partial<LabelFrame> = {}): LabelFrame {
  return {
    subject: 'self',
    variant: null,
    section: undefined,
    level: undefined,
    domain: undefined,
    ...overrides,
  };
}

describe('reading whose value a box holds', () => {
  it.each([
    ["Mother's Mobile Number", 'mother'],
    ['Father’s Name', 'father'], // typographic apostrophe, as pasted from Word
    ['Name of Father', 'father'],
    ["Father's/Guardian's Name", 'father'],
    ['Parent/Guardian Mobile', 'guardian'],
    ["Parent's Email", 'parent'],
    ['Emergency Contact Number', 'emergency'],
    ['पिता का नाम', 'father'],
    ['Mobile Number', 'self'],
  ])('%s → %s', (label, subject) => {
    expect(readFrame(field(label)).subject).toBe(subject);
  });

  it('does not mistake the applicant’s mother tongue for their mother', () => {
    expect(readFrame(field('Mother Tongue')).subject).toBe('self');
  });

  it('reads the subject from a control name when the label is silent', () => {
    expect(readFrame(field('', { selectors: ['#txtFatherMobile'] })).subject).toBe('father');
  });

  it('never borrows a subject from the question next door', () => {
    // A parent's name in the neighbouring label must not re-home this box.
    expect(readFrame(field('Mobile Number', { nearbyText: "Father's Name" })).subject).toBe('self');
  });
});

describe('reading which of the applicant’s values', () => {
  it.each([
    ['Confirm Email', 'confirm'],
    ['Re-enter Mobile Number', 'confirm'],
    ['Alternate Email ID', 'alternate'],
    ['Official Email', 'official'],
    ['Email ID (Official /college Email adderess)', 'official'],
    ['Email ID (Personal Email address)', 'personal'],
    ['Email ID', null],
  ])('%s → %s', (label, variant) => {
    expect(readFrame(field(label)).variant).toBe(variant);
  });

  it('does not read "other" inside "mother"', () => {
    expect(readFrame(field("Mother's Mobile")).variant).toBeNull();
  });
});

describe('composing a canonical key', () => {
  it.each<[FieldKey, Partial<LabelFrame>, FieldKey]>([
    ['contact.mobile', { subject: 'mother' }, 'family.mother_mobile'],
    ['contact.email', { subject: 'father' }, 'family.father_email'],
    ['identity.full_name', { subject: 'guardian' }, 'family.guardian_name'],
    ['identity.full_name', { subject: 'emergency' }, 'emergency.name'],
    ['contact.email', { variant: 'official' }, 'contact.official_email'],
    ['contact.mobile', { variant: 'alternate' }, 'contact.alt_mobile'],
    ['contact.email', { variant: 'confirm' }, 'contact.email'],
    ['education[].percentage', { level: 'class_12' }, 'education.class_12.percentage'],
    ['address.permanent.city', { section: 'correspondence' }, 'address.correspondence.city'],
    ['bank.branch', { domain: 'education' }, 'education[].branch'],
  ])('%s + %o → %s', (key, qualifiers, expected) => {
    expect(compose(key, frame(qualifiers))).toBe(expected);
  });

  it('applies domain before level, so "B.Tech Branch" is the undergraduate branch', () => {
    const read = readFrame(field('B.Tech Branch'));
    expect(compose('bank.branch', read)).toBe('education.undergraduate.branch');
  });

  it('lets a form-wide section outrank the field’s own text', () => {
    expect(compose('address.permanent.city', frame({ section: 'permanent' }), 'correspondence')).toBe(
      'address.correspondence.city',
    );
  });

  it('leaves keys that already name their owner alone', () => {
    expect(compose('family.father_occupation', frame({ subject: 'father' }))).toBe(
      'family.father_occupation',
    );
    expect(compose('identity.mother_tongue', frame({ subject: 'mother' }))).toBe(
      'identity.mother_tongue',
    );
  });
});

/**
 * The property the whole layer exists for. When a frame names someone other
 * than the applicant, the answer is that person's key or nothing — never the
 * applicant's own.
 */
describe('never handing someone else the applicant’s own value', () => {
  const applicantKeys: FieldKey[] = [
    'identity.full_name',
    'identity.dob',
    'contact.mobile',
    'contact.email',
    'id.aadhaar',
    'id.pan',
  ];

  it.each(['father', 'mother', 'guardian', 'parent', 'emergency'] as const)(
    'for %s',
    (subject) => {
      for (const key of applicantKeys) {
        expect(compose(key, frame({ subject })), `${subject} + ${key}`).not.toBe(key);
      }
    },
  );

  it('drops a parent’s date of birth rather than filling the applicant’s', () => {
    expect(compose('identity.dob', frame({ subject: 'father' }))).toBeNull();
  });

  it('drops a father’s Aadhaar rather than filling the applicant’s', () => {
    expect(compose('id.aadhaar', frame({ subject: 'father' }))).toBeNull();
  });

  it('drops an unspecified parent rather than picking one', () => {
    expect(compose('contact.mobile', frame({ subject: 'parent' }))).toBeNull();
  });

  it('drops an official mobile, which has no home', () => {
    expect(compose('contact.mobile', frame({ variant: 'official' }))).toBeNull();
  });

  it('says why a box was left alone', () => {
    expect(unhousedReason('identity.dob', frame({ subject: 'father' }))).toMatch(/your father/);
  });
});
