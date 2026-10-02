/**
 * Presentation grouping for the taxonomy.
 *
 * The taxonomy itself is a flat, stable namespace on purpose (§4). This module
 * is the one place that decides how those keys are grouped and labelled for a
 * human — keeping it out of `taxonomy.ts` means a UI relabel can never look
 * like a taxonomy change to a shipped site profile.
 */

import { FIELD_KEYS, type FieldKey } from '@/matching/taxonomy';

export interface FieldGroup {
  id: string;
  title: string;
  /** Shown under the title when the grouping needs explaining. */
  hint?: string;
  keys: FieldKey[];
  /**
   * A block only some people hold, hidden until it is claimed.
   *
   * Nobody holds a diploma *and* a bachelor's *and* a master's *and* a
   * doctorate, but every one of those blocks holds the same fifteen fields.
   * Shown together they are 105 boxes, nearly all of which the owner must
   * scroll past forever. A conditional block appears once it has a value in
   * it, or once the user asks for it by name; `completeness` in
   * `vault/profile-store.ts` has counted them this way from the start.
   */
  conditional?: boolean;
}

/** Human label for a key, derived from its last segment unless overridden. */
const LABELS: Partial<Record<FieldKey, string>> = {
  'identity.dob': 'Date of birth (YYYY-MM-DD)',
  'identity.category': 'Category (General / OBC / SC / ST)',
  'id.pan': 'PAN',
  'id.abc_id': 'ABC ID',
  'id.apaar': 'APAAR ID',
  'bank.ifsc': 'IFSC code',
  'contact.alt_mobile': 'Alternate mobile',
  'address.permanent.line1': 'Address line 1',
  'address.permanent.line2': 'Address line 2',
  'address.correspondence.line1': 'Address line 1',
  'address.correspondence.line2': 'Address line 2',
  'address.permanent.pincode': 'PIN code',
  'address.correspondence.pincode': 'PIN code',

  // Layer 3. Abbreviations that must not be title-cased into nonsense
  // ("Obc ncl", "Pwbd", "Udid") — these are how the forms themselves write them.
  'eligibility.caste': 'Caste',
  'eligibility.subcategory': 'Sub-category',
  'eligibility.obc_ncl': 'OBC (non-creamy layer)',
  'eligibility.ews': 'EWS',
  'eligibility.pwbd': 'Person with benchmark disability (PwBD)',
  'eligibility.disability_type': 'Type of disability',
  'eligibility.disability_percentage': 'Disability percentage',
  'eligibility.udid': 'UDID number',
  'eligibility.domicile_state': 'Domicile state',
  'eligibility.local_status': 'Local / non-local status',
  'eligibility.minority': 'Minority community',
  'eligibility.defence_ward': 'Ward of defence personnel',
  'eligibility.ex_serviceman': 'Ex-serviceman',
  'eligibility.sports_quota': 'Sports quota',
  'eligibility.ncc': 'NCC',
  'eligibility.nss': 'NSS',
  'eligibility.orphan': 'Orphan',
  'eligibility.age_relaxation': 'Age relaxation claimed',

  'emergency.name': 'Contact name',
  'emergency.relation': 'Relationship to you',
  'emergency.mobile': 'Contact mobile',

  'family.father_mobile': "Father's mobile",
  'family.mother_mobile': "Mother's mobile",
  'family.guardian_mobile': "Guardian's mobile",
  'family.father_email': "Father's email",
  'family.mother_email': "Mother's email",
  'family.guardian_email': "Guardian's email",
  'contact.alt_email': 'Alternate email',
  'contact.official_email': 'Official / college email',

  // Karnataka's RD numbers, as the certificates and the portals print them.
  'eligibility.caste_certificate_number': 'Caste certificate RD number',
  'eligibility.income_certificate_number': 'Income certificate RD number',
  'eligibility.article_371j_number': '371(J) Annexure-A RD number',

  // Documents. The label names the paper the way its issuer does, so the slot
  // is recognisable from the folder it was scanned out of.
  'doc.photo': 'Digital photograph',
  'doc.signature': 'Signature',
  'doc.thumb_impression': 'Thumb impression',
  'doc.aadhaar_card': 'Aadhaar card',
  'doc.pan_card': 'PAN card',
  'doc.voter_id': 'Voter ID card',
  'doc.driving_licence': 'Driving licence',
  'doc.passport': 'Passport',
  'doc.birth_certificate': 'Birth certificate',
  'doc.marksheet_10': 'Class 10 marks card',
  'doc.passing_certificate_10': 'Class 10 passing certificate',
  'doc.study_certificate_10': 'Class 10 study certificate',
  'doc.transfer_certificate_10': 'Class 10 transfer certificate (TC)',
  'doc.migration_certificate_10': 'Class 10 migration certificate',
  'doc.marksheet_11': '1st PUC / Class 11 marks card',
  'doc.marksheet_12': '2nd PUC / Class 12 marks card',
  'doc.passing_certificate_12': 'PUC / Class 12 passing certificate',
  'doc.study_certificate_12': 'PUC / Class 12 study certificate',
  'doc.transfer_certificate_12': 'PUC / Class 12 transfer certificate (TC)',
  'doc.migration_certificate_12': 'PUC / Class 12 migration certificate',
  'doc.conduct_certificate': 'Conduct / character certificate',
  'doc.passing_certificate': 'Passing certificate (no level named)',
  'doc.study_certificate': 'Study / bonafide certificate (no level named)',
  'doc.transfer_certificate': 'Transfer certificate (no level named)',
  'doc.migration_certificate': 'Migration certificate (no level named)',
  'doc.degree_certificate': 'Degree / provisional certificate',
  'doc.caste_certificate': 'Caste certificate',
  'doc.income_certificate': 'Income certificate',
  'doc.domicile_certificate': 'Domicile / nativity certificate',
  'doc.disability_certificate': 'Disability certificate',
  'doc.article_371j_certificate': '371(J) Annexure-A eligibility certificate',
  'doc.entrance_application_form': 'Entrance application form (KCET / CET)',
  'doc.entrance_fee_receipt': 'Entrance application fee receipt',
  'doc.entrance_admission_ticket': 'Admission ticket / hall ticket',
  'doc.entrance_result': 'Entrance result sheet',
  'doc.entrance_rank_card': 'Rank card',
  'doc.entrance_verification_slip': 'Document verification slip',
  'doc.entrance_claim_verification': 'Claim verification slip',
  'doc.entrance_option_entry': 'Option entry printout',
  'doc.seat_allotment_letter': 'Seat allotment letter',
  'doc.admission_fee_receipt': 'Admission fee payment receipt',
  'doc.admission_order': 'Admission order',
  'doc.bank_passbook': 'Bank passbook / cancelled cheque',
  'doc.scholarship_application': 'Scholarship application',

  // The course being read for now.
  'doc.semester_marksheet': 'Semester marks card',
  'doc.consolidated_marksheet': 'Consolidated marks card',
  'doc.bonafide_certificate': 'Bonafide certificate',
  'doc.college_id_card': 'College ID card',
  'doc.admission_letter': 'Admission letter',

  // Reservation, per category.
  'doc.caste_certificate_form_d': 'Form-D caste certificate',
  'doc.ews_certificate': 'EWS certificate',
  'doc.obc_certificate': 'OBC certificate',

  // Work, skills and everything besides study.
  'doc.resume': 'Resume / CV',
  'doc.internship_offer_letter': 'Internship offer letter',
  'doc.internship_certificate': 'Internship certificate',
  'doc.experience_certificate': 'Work experience certificate',
  'doc.recommendation_letter': 'Letter of recommendation',
  'doc.course_certificate': 'Course certificate',
  'doc.training_certificate': 'Training certificate',
  'doc.workshop_certificate': 'Workshop / seminar certificate',
  'doc.professional_certification': 'Professional certification',
  'doc.hackathon_certificate': 'Hackathon certificate',
  'doc.competition_certificate': 'Competition certificate',
  'doc.achievement_certificate': 'Merit / achievement certificate',
  'doc.project_report': 'Project report',
  'doc.project_certificate': 'Project certificate',
  'doc.publication': 'Published paper',
  'doc.patent_document': 'Patent document',
  'doc.sports_certificate': 'Sports certificate',
  'doc.ncc_certificate': 'NCC certificate',
  'doc.nss_certificate': 'NSS certificate',
  'doc.volunteering_certificate': 'Volunteering certificate',
  'doc.iti_marksheet': 'ITI marks card',
  'doc.iti_certificate': 'ITI trade certificate',

  // A course still being read for, and the exam that led to it.
  'education[].semester': 'Current semester',
  'education[].year_of_study': 'Year of study',
  'education.diploma.semester': 'Current semester',
  'education.diploma.year_of_study': 'Year of study',
  'education.undergraduate.semester': 'Current semester',
  'education.undergraduate.year_of_study': 'Year of study',
  'education.postgraduate.semester': 'Current semester',
  'education.postgraduate.year_of_study': 'Year of study',
  'entrance.exam_name': 'Which entrance exam',
  'entrance.registration_number': 'Registration number',
  'entrance.roll_number': 'Roll / hall ticket number',
  'entrance.rank': 'Rank',
  'entrance.score': 'Score',
  'entrance.year': 'Year of the exam',
  'eligibility.article_371j': 'Article 371(J) claimed',

  // One subject's own marks. "First language", because a card can carry three
  // and this is the one the box holds (`extract-education.ts`).
  'education[].marks_physics': 'Physics marks',
  'education[].marks_chemistry': 'Chemistry marks',
  'education[].marks_mathematics': 'Mathematics marks',
  'education[].marks_biology': 'Biology marks',
  'education[].marks_computer_science': 'Computer Science marks',
  'education[].marks_english': 'English marks',
  'education[].marks_language': 'First language marks',
  'education[].marks_science': 'Science marks',
  'education[].marks_social_science': 'Social Science marks',
  'education.class_10.marks_mathematics': 'Mathematics marks',
  'education.class_10.marks_science': 'Science marks',
  'education.class_10.marks_social_science': 'Social Science marks',
  'education.class_10.marks_english': 'English marks',
  'education.class_10.marks_language': 'First language marks',
  'education.class_12.marks_physics': 'Physics marks',
  'education.class_12.marks_chemistry': 'Chemistry marks',
  'education.class_12.marks_mathematics': 'Mathematics marks',
  'education.class_12.marks_biology': 'Biology marks',
  'education.class_12.marks_computer_science': 'Computer Science marks',
  'education.class_12.marks_english': 'English marks',
  'education.class_12.marks_language': 'First language marks',
};

/**
 * The seven qualification blocks (Layer 2), in the order a person earns them.
 *
 * Each holds the same fifteen fields, and the field segment is shared with the
 * generic `education[]` block so that a level named in a label can retarget a
 * generic match onto the right block — see `applyEducationLevel`.
 */
export const QUALIFICATION_LEVELS: ReadonlyArray<{ id: string; prefix: string; title: string }> = [
  { id: 'edu-class-10', prefix: 'education.class_10.', title: 'Class 10 (SSLC / Matriculation)' },
  { id: 'edu-class-12', prefix: 'education.class_12.', title: 'Class 12 (HSC / Intermediate / PUC)' },
  { id: 'edu-diploma', prefix: 'education.diploma.', title: 'Diploma / Polytechnic' },
  { id: 'edu-ug', prefix: 'education.undergraduate.', title: 'Undergraduate degree' },
  { id: 'edu-pg', prefix: 'education.postgraduate.', title: 'Postgraduate degree' },
  { id: 'edu-professional', prefix: 'education.professional_degree.', title: 'Professional degree' },
  { id: 'edu-phd', prefix: 'education.phd.', title: 'Doctorate / PhD' },
];

export function labelFor(key: FieldKey): string {
  const override = LABELS[key];
  if (override) return override;
  const last = key.split('.').pop() ?? key;
  const words = last.replace(/\[\]/g, '').replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function keysWithPrefix(prefix: string): FieldKey[] {
  return FIELD_KEYS.filter((k) => k.startsWith(prefix));
}

export const FIELD_GROUPS: FieldGroup[] = [
  { id: 'identity', title: 'Identity', keys: keysWithPrefix('identity.') },
  { id: 'family', title: 'Family', keys: keysWithPrefix('family.') },
  { id: 'contact', title: 'Contact', keys: keysWithPrefix('contact.') },
  {
    id: 'address-permanent',
    title: 'Permanent address',
    keys: keysWithPrefix('address.permanent.'),
  },
  {
    id: 'address-correspondence',
    title: 'Correspondence address',
    hint: 'Leave blank if it is the same as your permanent address.',
    keys: keysWithPrefix('address.correspondence.'),
  },
  {
    id: 'ids',
    title: 'Government IDs',
    hint: 'High sensitivity: masked here, and never filled from a guess.',
    keys: keysWithPrefix('id.'),
  },
  {
    id: 'emergency',
    title: 'Emergency contact',
    keys: keysWithPrefix('emergency.'),
  },
  {
    /*
     * Not a block anybody fills any more.
     *
     * A form that asks for marks without naming a qualification is answered
     * from the most recent one the user holds (`matching/qualifications.ts`),
     * so these fifteen boxes were fifteen duplicates of whatever was already
     * under Class 12. It stays here, conditional, for the one case that still
     * matters: a vault that has values in it from before that rule existed.
     */
    id: 'education',
    title: 'Education (typed with no qualification named)',
    hint:
      'Older entries. A form that asks without naming a qualification now uses your most ' +
      'recent one, so there is nothing to keep up to date here.',
    keys: keysWithPrefix('education['),
    conditional: true,
  },
  ...QUALIFICATION_LEVELS.map((level) => ({
    id: level.id,
    title: level.title,
    keys: keysWithPrefix(level.prefix),
    // Everyone has been to school; the rest are claimed when they exist.
    conditional: level.prefix !== 'education.class_10.' && level.prefix !== 'education.class_12.',
  })),
  {
    id: 'entrance',
    title: 'Entrance exam',
    hint: 'The numbers a portal asks for. The papers themselves are under Documents.',
    keys: keysWithPrefix('entrance.'),
  },
  {
    id: 'eligibility',
    title: 'Eligibility and reservation',
    hint:
      'Only fill what applies to you. Your broad category lives under Identity; ' +
      'these narrow it for forms that ask.',
    keys: keysWithPrefix('eligibility.'),
  },
  { id: 'bank', title: 'Bank account', keys: keysWithPrefix('bank.') },
];

/**
 * The document slots, in the folders a student keeps them in.
 *
 * The taxonomy stays flat (§4); this is the only place that says a scan of a
 * transfer certificate belongs beside the marks card it was issued with. The
 * order follows the folders themselves — the photographs every form wants,
 * identity, each qualification in the order it is earned, the claims, the
 * entrance exam, and the money — because that is the order a person collects
 * them in, and an empty slot is then obviously the one still to be scanned.
 *
 * `optional` marks a group most applicants never need. The editor collapses
 * those rather than hiding them: a slot nobody can find is a slot nobody fills.
 */
export interface DocumentGroup extends FieldGroup {
  optional?: boolean;
}

export const DOCUMENT_GROUPS: DocumentGroup[] = [
  {
    id: 'docs-photo',
    title: 'Photographs and signature',
    hint: 'Asked for by nearly every form. Printed copies are not kept here — save the digital original you print them from.',
    keys: ['doc.photo', 'doc.signature', 'doc.thumb_impression'],
  },
  {
    id: 'docs-identity',
    // Not "Identity": the profile fields above have a block of that name, and
    // one page with two sections called the same thing is a page nobody trusts.
    title: 'Identity documents',
    hint: 'High sensitivity: the passphrase is asked for again before any of these is attached.',
    keys: [
      'doc.aadhaar_card',
      'doc.pan_card',
      'doc.voter_id',
      'doc.birth_certificate',
      'doc.passport',
      'doc.driving_licence',
    ],
  },
  {
    id: 'docs-class-10',
    title: 'Class 10 (SSLC / CBSE)',
    keys: [
      'doc.marksheet_10',
      'doc.passing_certificate_10',
      'doc.study_certificate_10',
      'doc.transfer_certificate_10',
      'doc.migration_certificate_10',
    ],
  },
  {
    id: 'docs-class-12',
    title: 'PUC / Class 12',
    keys: [
      'doc.marksheet_11',
      'doc.marksheet_12',
      'doc.passing_certificate_12',
      'doc.study_certificate_12',
      'doc.transfer_certificate_12',
      'doc.migration_certificate_12',
      'doc.conduct_certificate',
    ],
  },
  {
    id: 'docs-iti',
    title: 'ITI',
    keys: ['doc.iti_marksheet', 'doc.iti_certificate'],
  },
  {
    id: 'docs-any-level',
    title: 'Certificates with no level named',
    hint:
      'Filled when a portal asks for a "study certificate" or a "transfer certificate" without ' +
      'saying which qualification. A question that names one — "SSLC study certificate" — uses ' +
      'the slot for that level above instead.',
    keys: [
      'doc.study_certificate',
      'doc.transfer_certificate',
      'doc.passing_certificate',
      'doc.migration_certificate',
    ],
  },
  {
    id: 'docs-college',
    title: 'College (the course you are on)',
    hint: 'Issued while you are studying, and asked for by scholarships, internships and transfers.',
    keys: [
      'doc.semester_marksheet',
      'doc.consolidated_marksheet',
      'doc.bonafide_certificate',
      'doc.college_id_card',
      'doc.admission_letter',
    ],
  },
  {
    id: 'docs-reservation',
    title: 'Caste and reservation',
    hint: 'The RD number printed on each of these is a text field, under Eligibility and reservation.',
    keys: [
      'doc.caste_certificate',
      'doc.caste_certificate_form_d',
      'doc.obc_certificate',
      'doc.ews_certificate',
      'doc.income_certificate',
      'doc.domicile_certificate',
      'doc.disability_certificate',
      'doc.article_371j_certificate',
    ],
  },
  {
    id: 'docs-entrance',
    title: 'Entrance exam and admission (KCET / KEA)',
    hint: 'Asked for at counselling and at the college, rather than on an application form.',
    optional: true,
    keys: [
      'doc.entrance_application_form',
      'doc.entrance_fee_receipt',
      'doc.entrance_admission_ticket',
      'doc.entrance_result',
      'doc.entrance_rank_card',
      'doc.entrance_verification_slip',
      'doc.entrance_claim_verification',
      'doc.entrance_option_entry',
      'doc.seat_allotment_letter',
      'doc.admission_fee_receipt',
      'doc.admission_order',
    ],
  },
  {
    id: 'docs-higher-education',
    title: 'Higher education',
    optional: true,
    keys: ['doc.degree_certificate'],
  },
  {
    id: 'docs-work',
    title: 'Work and internships',
    optional: true,
    keys: [
      'doc.resume',
      'doc.internship_offer_letter',
      'doc.internship_certificate',
      'doc.experience_certificate',
      'doc.recommendation_letter',
    ],
  },
  {
    id: 'docs-skills',
    title: 'Courses and training',
    optional: true,
    keys: [
      'doc.course_certificate',
      'doc.training_certificate',
      'doc.workshop_certificate',
      'doc.professional_certification',
    ],
  },
  {
    id: 'docs-achievements',
    title: 'Achievements and projects',
    optional: true,
    keys: [
      'doc.hackathon_certificate',
      'doc.competition_certificate',
      'doc.achievement_certificate',
      'doc.project_report',
      'doc.project_certificate',
      'doc.publication',
      'doc.patent_document',
    ],
  },
  {
    id: 'docs-service',
    title: 'Sports and service',
    hint: 'Some of these earn a quota or a weightage, which is why a portal asks for them.',
    optional: true,
    keys: [
      'doc.sports_certificate',
      'doc.ncc_certificate',
      'doc.nss_certificate',
      'doc.volunteering_certificate',
    ],
  },
  {
    id: 'docs-finance',
    title: 'Financial and scholarship',
    hint: 'Account number, IFSC and branch are text fields, under Bank account.',
    keys: ['doc.bank_passbook', 'doc.scholarship_application'],
  },
];

/** Every document slot, in the order the groups above put them in. */
export const DOCUMENT_KEYS: FieldKey[] = DOCUMENT_GROUPS.flatMap((group) => group.keys);

/** Input type hint for a key, so the browser offers the right keyboard. */
export function inputTypeFor(key: FieldKey): 'text' | 'email' | 'tel' | 'date' | 'number' {
  if (key === 'identity.dob') return 'date';
  if (key === 'contact.email') return 'email';
  if (key.includes('mobile') || key === 'contact.landline') return 'tel';
  if (key.includes('pincode') || key.includes('year_of_passing')) return 'text';
  return 'text';
}

/**
 * The block a key is shown under, and where in the editor it sits.
 *
 * Used by the document reader, which hands back a dozen values at once from a
 * single marks card: ungrouped they are a wall of boxes, and grouped under the
 * same headings the editor uses, they are recognisably "the Class 10 block,
 * filled in". `null` means no block claims the key — the caller says so rather
 * than filing it under a heading it does not belong to.
 */
export function groupFor(key: FieldKey): FieldGroup | null {
  return (
    FIELD_GROUPS.find((group) => group.keys.includes(key)) ??
    DOCUMENT_GROUPS.find((group) => group.keys.includes(key)) ??
    null
  );
}

/** Where a group sits in the editor, for putting sections back in that order. */
export function groupOrder(id: string): number {
  const fields = FIELD_GROUPS.findIndex((group) => group.id === id);
  if (fields !== -1) return fields;
  const documents = DOCUMENT_GROUPS.findIndex((group) => group.id === id);
  if (documents !== -1) return FIELD_GROUPS.length + documents;
  return Number.MAX_SAFE_INTEGER;
}
