/**
 * Reading what a label *means*, as opposed to which words it contains (§ Phase 4).
 *
 * ## Why this exists
 *
 * The synonym dictionary answers "which attribute is this?" — a name, a mobile
 * number, a percentage. It cannot answer *whose*, *which one*, or *which
 * qualification*, because those are modifiers on the attribute rather than
 * words that name it. Asked about "Mother's Mobile Number", a dictionary finds
 * "mobile number" and answers `contact.mobile`: the applicant's own number, at
 * 0.80, written into the box for their mother's.
 *
 * So a label is read as a frame — an attribute plus the qualifiers that decide
 * which canonical key it is — and the key is *composed* from the two:
 *
 *     attribute   (dictionary)   contact.mobile
 *   + subject     "Mother's"  →  family.mother_mobile
 *
 *     attribute                  education[].percentage
 *   + level       "12th"      →  education.class_12.percentage
 *
 *     attribute                  address.permanent.city
 *   + section     "Current"   →  address.correspondence.city
 *
 * Nothing here knows which portal it is on. The same frame is read the same way
 * on a scholarship portal, a Google Form and a campus drive.
 *
 * ## The rule that makes it safe
 *
 * When a frame has no home in the taxonomy — a father's date of birth, an
 * official mobile — `compose` returns **null** and the signal is dropped. It
 * never falls back to the unqualified key, because the unqualified key is the
 * applicant's own value, and writing that into someone else's box is exactly
 * the confident mis-match §6.4 ranks above a miss.
 *
 * ## What it replaced
 *
 * Separate passes, each added after a real mis-fill: address sections,
 * qualification levels, and the two kinds of "branch". They were the same idea
 * written three times. They now live here as qualifiers of one frame; subject
 * and variant are new. (A label's declared value *shape* stays a veto in
 * `traits.ts`, because it filters keys rather than composing them.)
 *
 * Pure: a `FieldDescriptor` in, a frame out. No DOM, no portal, no profile.
 */

import { NEARBY_SEPARATOR, type FieldDescriptor } from '@/shared/types';
import { isFieldKey, type FieldKey } from './taxonomy';
import { GENERIC_TOKENS } from './normalise';

// ---------------------------------------------------------------------------
// The frame
// ---------------------------------------------------------------------------

export type AddressSection = 'permanent' | 'correspondence';
export type Subject = 'self' | 'father' | 'mother' | 'guardian' | 'parent' | 'emergency';
export type Variant = 'confirm' | 'alternate' | 'official' | 'personal';
export type Domain = 'bank' | 'education';
export type FamilyMember = 'father' | 'mother' | 'guardian';

export interface LabelFrame {
  /** Whose value the box holds. `self` unless the label names someone else. */
  subject: Subject;
  /** Which of the applicant's several values of one kind — alternate, official… */
  variant: Variant | null;
  /** The address block the field's own text names, if any. */
  section: AddressSection | undefined;
  /** The qualification the field's own text names, if any. */
  level: string | undefined;
  /** For a word that is two fields ("Branch"): which subject area the form is in. */
  domain: Domain | undefined;
  /**
   * Every family member the box's own words name. Usually one; "Father or
   * Guardian Name" names two, and a key for either is then the label's own
   * reading rather than a stand-in to be re-homed.
   */
  members?: ReadonlySet<FamilyMember>;
}

// ---------------------------------------------------------------------------
// Qualifier vocabularies
// ---------------------------------------------------------------------------

const CORRESPONDENCE_HINT = /correspondence|communication|present|current|mailing|पत्राचार|वर्तमान/i;
const PERMANENT_HINT = /permanent|native|स्थायी/i;

/**
 * Level qualifiers, in the words Indian forms actually use.
 *
 * Order matters: the first pattern that hits wins, so the more specific
 * qualifications come before the ones whose words they contain. "Post
 * Graduation" contains "graduation"; putting undergraduate first would swallow
 * every postgraduate field on the form.
 */
const EDUCATION_LEVELS: ReadonlyArray<{ level: string; pattern: RegExp }> = [
  { level: 'class_10', pattern: /\b(10th|x\s*th|class\s*10|class\s*x(?![iv])|std\s*10|sslc|matric(ulation)?|secondary(?!\s*higher))\b/i },
  { level: 'class_12', pattern: /\b(12th|xii|x\s*ii|class\s*12|std\s*12|hsc|puc|pre.?university|intermediate|(higher|senior)\s*secondary)\b/i },
  { level: 'phd', pattern: /\b(ph\.?\s?d|doctoral|doctorate)\b/i },
  { level: 'professional_degree', pattern: /\bprofessional\s*(degree|qualification|course)\b/i },
  { level: 'postgraduate', pattern: /\b(pg|post.?graduat\w*|masters?|m\.?tech|m\.?sc|m\.?com|m\.?a\b|mba|mca)\b/i },
  { level: 'diploma', pattern: /\b(diploma|polytechnic)\b/i },
  { level: 'undergraduate', pattern: /\b(ug|under.?graduat\w*|bachelors?|graduation|b\.?tech|b\.?e\b|b\.?sc|b\.?com|b\.?a\b|bca|bba)\b/i },
];

/**
 * "Branch" is two different fields, and only the surrounding form says which.
 *
 * On a campus form it is the academic discipline; in a bank block it is the
 * branch of the bank. Where the context says neither — or both — no domain is
 * set, the two readings stay in competition, and the ambiguity cap flags the
 * field for a person instead of guessing.
 */
const BANK_CONTEXT =
  /\b(bank|ifsc|micr|passbook|account|disbursal|branch\s*code|financial\s*system\s*code)\b/i;
const EDUCATION_CONTEXT =
  /\b(course|degree|college|university|board|semester|stream|discipline|specialis|specializ|roll\s*no|marks|cgpa|percentage|programme|qualification)\w*/i;

/**
 * Whose value the box holds, in first-match order.
 *
 * "Father's/Guardian's Name" is the usual Indian phrasing for the father, so
 * father is tried before guardian; "Parent/Guardian" names no parent in
 * particular, so guardian is tried before the generic parent. "Mother Tongue"
 * is the applicant's language, not their mother's, and is excluded outright.
 *
 * Read from the field's own label and control name only — never the text
 * around it — because neighbouring labels routinely name a parent, and a
 * subject borrowed from the question above would re-home the applicant's own
 * mobile number onto their father.
 */
const SUBJECTS: ReadonlyArray<{ subject: Exclude<Subject, 'self'>; pattern: RegExp }> = [
  { subject: 'father', pattern: /\bfather(['’]?s)?\b|पिता/i },
  { subject: 'mother', pattern: /\bmother(['’]?s)?\b(?!\s*tongue)|माता/i },
  { subject: 'guardian', pattern: /\bguardian(['’]?s)?\b|अभिभावक/i },
  { subject: 'parent', pattern: /\bparent(['’]?s)?\b/i },
  { subject: 'emergency', pattern: /\bemergency\b/i },
];

/** Which of the applicant's own values, in first-match order. */
const VARIANTS: ReadonlyArray<{ variant: Variant; pattern: RegExp }> = [
  { variant: 'confirm', pattern: /\b(confirm|re-?\s?enter|re-?\s?type|verify)\b/i },
  { variant: 'alternate', pattern: /\b(alt|alternate|alternative|secondary|additional|other)\b/i },
  { variant: 'official', pattern: /\b(official|college|institut\w*|university|work|office)\b/i },
  { variant: 'personal', pattern: /\bpersonal\b/i },
];

// ---------------------------------------------------------------------------
// Composition tables
// ---------------------------------------------------------------------------

/**
 * Keys whose value belongs to the applicant, and so change owner — or are
 * dropped — when a label names somebody else.
 *
 * Deliberately a closed list rather than "everything under identity.*": the
 * applicant's mother tongue, category and religion are asked about with a
 * parent's word nearby often enough that re-homing them would be wrong.
 */
const APPLICANT_ATTRIBUTES: ReadonlySet<FieldKey> = new Set<FieldKey>([
  'identity.full_name',
  'identity.given_name',
  'identity.middle_name',
  'identity.surname',
  'identity.dob',
  'contact.email',
  'contact.mobile',
  'contact.alt_mobile',
  'contact.landline',
  'contact.alt_email',
  'contact.official_email',
  'id.aadhaar',
  'id.pan',
  'id.passport',
  'id.voter',
  'id.driving_licence',
  'id.abc_id',
  'id.apaar',
]);

/** Where an applicant attribute lives when it belongs to someone else. Absent = nowhere. */
const SUBJECT_HOMES: Readonly<
  Record<Exclude<Subject, 'self'>, Partial<Record<FieldKey, FieldKey>>>
> = {
  father: {
    'identity.full_name': 'family.father_name',
    'contact.mobile': 'family.father_mobile',
    'contact.email': 'family.father_email',
  },
  mother: {
    'identity.full_name': 'family.mother_name',
    'contact.mobile': 'family.mother_mobile',
    'contact.email': 'family.mother_email',
  },
  guardian: {
    'identity.full_name': 'family.guardian_name',
    'contact.mobile': 'family.guardian_mobile',
    'contact.email': 'family.guardian_email',
  },
  // "Parent's Mobile" does not say which parent. Guessing one is a coin toss
  // with somebody's phone number, so every parent attribute is unhoused.
  parent: {},
  emergency: {
    'identity.full_name': 'emergency.name',
    'contact.mobile': 'emergency.mobile',
    'contact.alt_mobile': 'emergency.mobile',
    'contact.landline': 'emergency.mobile',
  },
};

/** Attributes the applicant has several of. */
const VARIANT_ATTRIBUTES: ReadonlySet<FieldKey> = new Set<FieldKey>(['contact.email', 'contact.mobile']);

const VARIANT_HOMES: Readonly<Record<Variant, Partial<Record<FieldKey, FieldKey>>>> = {
  // The same value typed twice. The duplicate check in `matchForm` caps it.
  confirm: { 'contact.email': 'contact.email', 'contact.mobile': 'contact.mobile' },
  personal: { 'contact.email': 'contact.email', 'contact.mobile': 'contact.mobile' },
  alternate: { 'contact.email': 'contact.alt_email', 'contact.mobile': 'contact.alt_mobile' },
  official: { 'contact.email': 'contact.official_email' },
};

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

function firstMatch<T extends { pattern: RegExp }>(list: readonly T[], text: string): T | undefined {
  return list.find((entry) => entry.pattern.test(text));
}

/**
 * The control's id and name, as words.
 *
 * `selectors` is where they end up (`#txtFatherMobile`, `[name="ddlAcctType"]`),
 * split on case and punctuation first because `\bfather\b` cannot see the word
 * inside `txtFatherMobile`.
 */
function identifierWords(field: FieldDescriptor): string {
  return field.selectors
    .join(' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[^A-Za-z0-9]+/g, ' ');
}

/** The address block this field's own text names, if any. */
export function ownSection(field: FieldDescriptor): AddressSection | undefined {
  const context = `${field.nearbyText} ${field.labelText}`;
  if (CORRESPONDENCE_HINT.test(context)) return 'correspondence';
  if (PERMANENT_HINT.test(context)) return 'permanent';
  return undefined;
}

function ownLevel(field: FieldDescriptor): string | undefined {
  const context = `${field.labelText} ${field.placeholder ?? ''} ${field.nearbyText}`;
  return firstMatch(EDUCATION_LEVELS, context)?.level;
}

/**
 * Words that make a heading a *section* heading.
 *
 * The distinction is the whole safety of carrying a subject down. "Father's
 * Details" governs the boxes beneath it. "Father's Name", set as a heading by a
 * form builder that gives every question one, is the question above — and a
 * subject borrowed from it would re-home the applicant's own mobile number onto
 * their father.
 */
const SECTION_WORDS =
  /\b(details?|particulars|information|info|section|part|record|profile|data|background|contact)\b|विवरण/i;

/** A heading that names an attribute is a question, whatever else it says. */
const ATTRIBUTE_WORDS =
  /\b(name|number|no|mobile|phone|e-?mail|date|dob|birth|occupation|income|address|age|aadhaar|pan|signature|photo)\b/i;

/** Subject words and the punctuation between them: "Father / Guardian", "1. Mother's". */
const SUBJECT_ONLY = /\b(father|mother|guardian|parent)(['’]?s)?\b|पिता|माता|अभिभावक|[\s\d.:()/|&,\-–—]+/gi;

/** A heading about the applicant — or the applicant *and* someone else — carries nothing. */
const APPLICANT_WORDS = /\b(applicant|candidate|student|personal|self)\b/i;

/**
 * The subject a section heading carries down to the boxes beneath it.
 *
 * `nearbyText` lists the governing headings nearest first, one per
 * `NEARBY_SEPARATOR` (`resolveNearbyText`). Only the nearest decides: a nearer
 * heading that names nobody ("Contact Details") ends the reach of an older one
 * ("Father's Details") instead of letting it leak through — which is how a
 * person reads the page.
 */
export function headingSubject(nearbyText: string): Exclude<Subject, 'self'> | undefined {
  const nearest = nearbyText.split(NEARBY_SEPARATOR)[0]?.trim() ?? '';
  if (nearest === '' || APPLICANT_WORDS.test(nearest) || ATTRIBUTE_WORDS.test(nearest)) {
    return undefined;
  }

  const named = firstMatch(SUBJECTS, nearest)?.subject;
  if (named === undefined) return undefined;

  // "Father's Details" — or a heading that is nothing but the subject: "Mother".
  const bare = nearest.replace(SUBJECT_ONLY, '') === '';
  return bare || SECTION_WORDS.test(nearest) ? named : undefined;
}

const FAMILY_MEMBERS: ReadonlySet<Subject> = new Set<Subject>(['father', 'mother', 'guardian']);

function isFamilyMember(subject: Subject): subject is FamilyMember {
  return FAMILY_MEMBERS.has(subject);
}

export function readFrame(field: FieldDescriptor): LabelFrame {
  const identifiers = identifierWords(field);
  const own = `${field.labelText} ${field.placeholder ?? ''} ${identifiers}`;
  const level = ownLevel(field);

  const context = `${field.labelText} ${field.nearbyText} ${identifiers}`;
  const bank = BANK_CONTEXT.test(context);
  // Naming a qualification is itself educational context: "B.Tech Branch".
  const education = EDUCATION_CONTEXT.test(context) || level !== undefined;

  return {
    // The box's own words first; a section heading speaks only for a box that
    // names nobody. "Mother's Name" under "Father's Details" is the mother's.
    subject: firstMatch(SUBJECTS, own)?.subject ?? headingSubject(field.nearbyText) ?? 'self',
    variant: firstMatch(VARIANTS, own)?.variant ?? null,
    section: ownSection(field),
    level,
    domain: bank && !education ? 'bank' : education && !bank ? 'education' : undefined,
    members: new Set(
      SUBJECTS.filter((entry) => entry.pattern.test(own))
        .map((entry) => entry.subject)
        .filter(isFamilyMember),
    ),
  };
}

// ---------------------------------------------------------------------------
// Composing
// ---------------------------------------------------------------------------

/**
 * Levels that have a document of their own, and the suffix that names it.
 *
 * Only the school levels: a degree's certificates are one per course, not one
 * per level, and they keep their own keys.
 */
const DOCUMENT_LEVEL_SUFFIX: Readonly<Record<string, string | undefined>> = {
  class_10: '_10',
  class_12: '_12',
};

/**
 * The canonical key this frame gives an attribute — or null when it has none.
 *
 * `carried` is the address section resolved across the whole form by
 * `matchForm`, which outranks the field's own text; a single-field call has no
 * block to read and falls back to the frame's.
 *
 * Qualifiers apply in a fixed order: section, domain, level, then subject or
 * variant. Domain comes before level so that "B.Tech Branch" becomes the
 * academic branch *and then* the undergraduate one.
 */
export function compose(key: FieldKey, frame: LabelFrame, carried?: AddressSection): FieldKey | null {
  let k = key;

  if (k.startsWith('address.')) {
    const section = carried ?? frame.section;
    if (section === 'correspondence') {
      k = k.replace('address.permanent.', 'address.correspondence.') as FieldKey;
    } else if (section === 'permanent') {
      k = k.replace('address.correspondence.', 'address.permanent.') as FieldKey;
    }
  }

  if ((k === 'education[].branch' || k === 'bank.branch') && frame.domain !== undefined) {
    k = frame.domain === 'bank' ? 'bank.branch' : 'education[].branch';
  }

  if (k.startsWith('education[].') && frame.level !== undefined) {
    const retargeted = k.replace('education[].', `education.${frame.level}.`);
    if (isFieldKey(retargeted)) k = retargeted;
  }

  /*
   * The same certificate, issued once per qualification.
   *
   * A student holds a study certificate and a transfer certificate for Class
   * 10 and another pair for PUC, and only the question says which is wanted.
   * The bare key is the slot for a portal that names no level; naming one
   * moves the match onto that level's document, exactly as the education
   * block above does with its fields. The suffix is the one the document keys
   * have always used (`doc.marksheet_10`).
   */
  if (k.startsWith('doc.') && frame.level !== undefined) {
    const suffix = DOCUMENT_LEVEL_SUFFIX[frame.level];
    const retargeted = suffix === undefined ? k : `${k}${suffix}`;
    if (isFieldKey(retargeted)) k = retargeted;
  }

  const subject = frame.subject;

  /*
   * A key that already names a family member, meeting a box about a different
   * one. "Mother's Occupation" finds `family.father_occupation`, because the
   * dictionary's occupation phrases are the father's. Re-home it to the member
   * the box is about when that key exists; otherwise there is nowhere to keep
   * it, and the father's value must not stand in for the mother's.
   */
  const member = /^family\.(father|mother|guardian)_(.+)$/.exec(k);
  if (
    member &&
    isFamilyMember(subject) &&
    member[1] !== subject &&
    // A label naming both people ("Father or Guardian Name") means the
    // guardian reading is its own, not a stand-in for the father's.
    !frame.members?.has(member[1] as FamilyMember)
  ) {
    const rehomed = `family.${subject}_${member[2]}`;
    return isFieldKey(rehomed) ? rehomed : null;
  }

  if (subject !== 'self' && APPLICANT_ATTRIBUTES.has(k)) {
    return SUBJECT_HOMES[subject][k] ?? null;
  }

  const variant = frame.variant;
  if (subject === 'self' && variant !== null && VARIANT_ATTRIBUTES.has(k)) {
    return VARIANT_HOMES[variant][k] ?? null;
  }

  return k;
}

const SUBJECT_WORDS: Readonly<Record<Exclude<Subject, 'self'>, string>> = {
  father: 'your father',
  mother: 'your mother',
  guardian: 'your guardian',
  parent: 'a parent it does not name',
  emergency: 'your emergency contact',
};

/**
 * Why a signal was dropped, for the review screen.
 *
 * A blank field with "No rule matched" invites the user to think the extension
 * failed. A blank field that says *why* it was left alone is the extension
 * doing its job — and tells the user the box is theirs to fill.
 */
export function unhousedReason(key: FieldKey, frame: LabelFrame): string {
  const attribute = (key.split('.').pop() ?? key)
    .replace(/^(father|mother|guardian)_/, '')
    .replace(/_/g, ' ')
    .replace(/^dob$/, 'date of birth');
  if (frame.subject !== 'self') {
    return `this box is about ${SUBJECT_WORDS[frame.subject]}, and there is no saved ${attribute} for them — left for you to fill`;
  }
  return `this box asks for ${frame.variant ?? 'another'} ${attribute}, which is not saved separately — left for you to fill`;
}

/**
 * Subject words, as the tokeniser leaves them ("Father's" becomes "fathers").
 *
 * A subject word says whose value a box holds. It never names the attribute,
 * so it must not be what carries a partial match: "Father's Date of Birth"
 * shares only "fathers" with "Father's Name", and that is not evidence the box
 * wants a name — it is evidence the box is about a father.
 */
export const SUBJECT_TOKENS: ReadonlySet<string> = new Set([
  'father', 'fathers', 'mother', 'mothers', 'guardian', 'guardians', 'parent', 'parents',
  'पिता', 'माता', 'अभिभावक',
]);

/** True when the only meaningful words two phrases share are subject words. */
export function onlySubjectInCommon(a: readonly string[], b: readonly string[]): boolean {
  const other = new Set(b);
  const shared = a.filter((token) => other.has(token) && !GENERIC_TOKENS.has(token));
  return shared.length > 0 && shared.every((token) => SUBJECT_TOKENS.has(token));
}
