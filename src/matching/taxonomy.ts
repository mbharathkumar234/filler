/**
 * The canonical field taxonomy (§4 of IMPLEMENTATION_PLAN.md).
 *
 * Everything keys off this namespace: the vault schema, matcher output, site
 * profiles, the LLM's closed vocabulary, and the review screen.
 *
 * HARD RULES
 *  1. Keys are APPEND-ONLY. Renaming a key breaks every shipped site profile.
 *     To rename, add the new key and register the old one in `KEY_ALIASES`.
 *  2. Every key carries a sensitivity tier (§6.3). `high` keys require
 *     re-authentication before fill (Phase 6) and are never auto-filled from an
 *     LLM-only match (Phase 8).
 *  3. The LLM may only return a key from this list, plus the literal `'unknown'`.
 */

export const FIELD_KEYS = [
  // identity
  'identity.full_name',
  'identity.given_name',
  'identity.middle_name',
  'identity.surname',
  'identity.dob',
  'identity.gender',
  'identity.category',
  'identity.nationality',
  'identity.marital_status',
  'identity.religion',
  'identity.mother_tongue',
  'identity.blood_group',

  // family
  'family.father_name',
  'family.mother_name',
  'family.guardian_name',
  'family.father_occupation',
  'family.annual_income',

  // contact
  'contact.email',
  'contact.mobile',
  'contact.alt_mobile',
  'contact.landline',

  // address — permanent
  'address.permanent.line1',
  'address.permanent.line2',
  'address.permanent.city',
  'address.permanent.district',
  'address.permanent.state',
  'address.permanent.pincode',
  'address.permanent.country',

  // address — correspondence (same shape as permanent)
  'address.correspondence.line1',
  'address.correspondence.line2',
  'address.correspondence.city',
  'address.correspondence.district',
  'address.correspondence.state',
  'address.correspondence.pincode',
  'address.correspondence.country',

  // government ids (HIGH SENSITIVITY — see §6.3)
  'id.aadhaar',
  'id.pan',
  'id.passport',
  'id.voter',
  'id.driving_licence',
  'id.abc_id',
  'id.apaar',

  // education (repeatable rows)
  'education[].level',
  'education[].board_or_university',
  'education[].institution',
  'education[].roll_number',
  'education[].year_of_passing',
  'education[].marks_obtained',
  'education[].max_marks',
  'education[].percentage',
  'education[].cgpa',

  // banking
  'bank.account_holder',
  'bank.account_number',
  'bank.ifsc',
  'bank.bank_name',
  'bank.branch',
  'bank.account_type',

  // documents
  'doc.photo',
  'doc.signature',
  'doc.aadhaar_card',
  'doc.pan_card',
  'doc.marksheet_10',
  'doc.marksheet_12',
  'doc.degree_certificate',
  'doc.income_certificate',
  'doc.caste_certificate',
  'doc.domicile_certificate',
  'doc.bank_passbook',
  'doc.disability_certificate',

  // education — generic block, for a label that names no level
  'education[].course',
  'education[].branch',
  'education[].specialization',
  'education[].start_year',
  'education[].registration_number',
  'education[].subjects',
  'education[].result_status',

  // education — Class 10 / SSLC / Matriculation
  'education.class_10.institution',
  'education.class_10.board_or_university',
  'education.class_10.course',
  'education.class_10.branch',
  'education.class_10.specialization',
  'education.class_10.start_year',
  'education.class_10.year_of_passing',
  'education.class_10.roll_number',
  'education.class_10.registration_number',
  'education.class_10.marks_obtained',
  'education.class_10.max_marks',
  'education.class_10.percentage',
  'education.class_10.cgpa',
  'education.class_10.subjects',
  'education.class_10.result_status',

  // education — Class 12 / HSC / Intermediate
  'education.class_12.institution',
  'education.class_12.board_or_university',
  'education.class_12.course',
  'education.class_12.branch',
  'education.class_12.specialization',
  'education.class_12.start_year',
  'education.class_12.year_of_passing',
  'education.class_12.roll_number',
  'education.class_12.registration_number',
  'education.class_12.marks_obtained',
  'education.class_12.max_marks',
  'education.class_12.percentage',
  'education.class_12.cgpa',
  'education.class_12.subjects',
  'education.class_12.result_status',

  // education — Diploma / Polytechnic
  'education.diploma.institution',
  'education.diploma.board_or_university',
  'education.diploma.course',
  'education.diploma.branch',
  'education.diploma.specialization',
  'education.diploma.start_year',
  'education.diploma.year_of_passing',
  'education.diploma.roll_number',
  'education.diploma.registration_number',
  'education.diploma.marks_obtained',
  'education.diploma.max_marks',
  'education.diploma.percentage',
  'education.diploma.cgpa',
  'education.diploma.subjects',
  'education.diploma.result_status',

  // education — Undergraduate degree
  'education.undergraduate.institution',
  'education.undergraduate.board_or_university',
  'education.undergraduate.course',
  'education.undergraduate.branch',
  'education.undergraduate.specialization',
  'education.undergraduate.start_year',
  'education.undergraduate.year_of_passing',
  'education.undergraduate.roll_number',
  'education.undergraduate.registration_number',
  'education.undergraduate.marks_obtained',
  'education.undergraduate.max_marks',
  'education.undergraduate.percentage',
  'education.undergraduate.cgpa',
  'education.undergraduate.subjects',
  'education.undergraduate.result_status',

  // education — Postgraduate degree
  'education.postgraduate.institution',
  'education.postgraduate.board_or_university',
  'education.postgraduate.course',
  'education.postgraduate.branch',
  'education.postgraduate.specialization',
  'education.postgraduate.start_year',
  'education.postgraduate.year_of_passing',
  'education.postgraduate.roll_number',
  'education.postgraduate.registration_number',
  'education.postgraduate.marks_obtained',
  'education.postgraduate.max_marks',
  'education.postgraduate.percentage',
  'education.postgraduate.cgpa',
  'education.postgraduate.subjects',
  'education.postgraduate.result_status',

  // education — Professional degree
  'education.professional_degree.institution',
  'education.professional_degree.board_or_university',
  'education.professional_degree.course',
  'education.professional_degree.branch',
  'education.professional_degree.specialization',
  'education.professional_degree.start_year',
  'education.professional_degree.year_of_passing',
  'education.professional_degree.roll_number',
  'education.professional_degree.registration_number',
  'education.professional_degree.marks_obtained',
  'education.professional_degree.max_marks',
  'education.professional_degree.percentage',
  'education.professional_degree.cgpa',
  'education.professional_degree.subjects',
  'education.professional_degree.result_status',

  // education — Doctorate / PhD
  'education.phd.institution',
  'education.phd.board_or_university',
  'education.phd.course',
  'education.phd.branch',
  'education.phd.specialization',
  'education.phd.start_year',
  'education.phd.year_of_passing',
  'education.phd.roll_number',
  'education.phd.registration_number',
  'education.phd.marks_obtained',
  'education.phd.max_marks',
  'education.phd.percentage',
  'education.phd.cgpa',
  'education.phd.subjects',
  'education.phd.result_status',

  // eligibility and reservation (Layer 3)
  'eligibility.caste',
  'eligibility.subcategory',
  'eligibility.obc_ncl',
  'eligibility.ews',
  'eligibility.pwbd',
  'eligibility.disability_type',
  'eligibility.disability_percentage',
  'eligibility.udid',
  'eligibility.domicile_state',
  'eligibility.local_status',
  'eligibility.minority',
  'eligibility.defence_ward',
  'eligibility.ex_serviceman',
  'eligibility.sports_quota',
  'eligibility.ncc',
  'eligibility.nss',
  'eligibility.orphan',
  'eligibility.age_relaxation',

  // emergency contact (Layer 1)
  'emergency.name',
  'emergency.relation',
  'emergency.mobile',

  // parents' contact and the applicant's other emails — reached by composition
  // in `frame.ts`, not by synonyms of their own
  'family.father_mobile',
  'family.mother_mobile',
  'family.guardian_mobile',
  'family.father_email',
  'family.mother_email',
  'family.guardian_email',
  'contact.alt_email',
  'contact.official_email',
  // documents — a student's own folders (§ vault structure).
  //
  // Certificates that exist once per qualification carry a level suffix, the
  // way `doc.marksheet_10` always has. The bare key is the slot for a portal
  // that names no level; `compose` moves a match onto the level when the
  // question names one ("SSLC study certificate").
  'doc.voter_id',
  'doc.birth_certificate',
  'doc.passport',
  'doc.driving_licence',
  'doc.passing_certificate',
  'doc.passing_certificate_10',
  'doc.passing_certificate_12',
  'doc.study_certificate',
  'doc.study_certificate_10',
  'doc.study_certificate_12',
  'doc.transfer_certificate',
  'doc.transfer_certificate_10',
  'doc.transfer_certificate_12',
  'doc.migration_certificate',
  'doc.migration_certificate_10',
  'doc.migration_certificate_12',
  'doc.conduct_certificate',
  'doc.marksheet_11',
  'doc.article_371j_certificate',

  // documents — entrance exam and admission (KCET/KEA, and the same shapes
  // COMEDK, JEE and NEET use)
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

  // documents — biometric and scholarship
  'doc.thumb_impression',
  'doc.scholarship_application',

  // the numbers printed on a certificate, which a portal asks for as text
  // rather than as a file (Karnataka's RD numbers)
  'eligibility.caste_certificate_number',
  'eligibility.income_certificate_number',
  'eligibility.article_371j_number',
  // documents — the course being read for now, and the papers it issues
  'doc.semester_marksheet',
  'doc.consolidated_marksheet',
  'doc.bonafide_certificate',
  'doc.college_id_card',
  'doc.admission_letter',

  // documents — reservation, per category (the generic caste certificate above
  // is what a portal asks for when it does not name the form)
  'doc.caste_certificate_form_d',
  'doc.ews_certificate',
  'doc.obc_certificate',

  // documents — work, skills and what a student has done besides study
  'doc.resume',
  'doc.internship_offer_letter',
  'doc.internship_certificate',
  'doc.experience_certificate',
  'doc.recommendation_letter',
  'doc.course_certificate',
  'doc.training_certificate',
  'doc.workshop_certificate',
  'doc.professional_certification',
  'doc.hackathon_certificate',
  'doc.competition_certificate',
  'doc.achievement_certificate',
  'doc.project_report',
  'doc.project_certificate',
  'doc.publication',
  'doc.patent_document',
  'doc.sports_certificate',
  'doc.ncc_certificate',
  'doc.nss_certificate',
  'doc.volunteering_certificate',

  // documents — the trade route out of Class 10
  'doc.iti_marksheet',
  'doc.iti_certificate',

  // a course still being read for: which semester, and which year of it
  'education[].semester',
  'education[].year_of_study',
  'education.diploma.semester',
  'education.diploma.year_of_study',
  'education.undergraduate.semester',
  'education.undergraduate.year_of_study',
  'education.postgraduate.semester',
  'education.postgraduate.year_of_study',

  // the entrance exam, as the numbers a portal asks for rather than the papers
  'entrance.exam_name',
  'entrance.registration_number',
  'entrance.roll_number',
  'entrance.rank',
  'entrance.score',
  'entrance.year',

  // the claim itself, beside the RD number printed on its certificate
  'eligibility.article_371j',

  /*
   * The taluk, which every Karnataka portal asks for and no key held.
   *
   * An Aadhaar letter prints it as "Sub District", a caste certificate as
   * "Taluk", a scholarship form as "Taluka" or "Tehsil". It sits between the
   * village and the district and is not either of them, so filing it under
   * `city` or `district` puts a wrong answer in a box that is checked against
   * the certificate.
   */
  'address.permanent.taluk',
  'address.correspondence.taluk',

  /*
   * Each subject's own marks.
   *
   * A marks card has a row per subject, and an entrance application asks for
   * Physics, Chemistry and Mathematics by name. There was one `subjects` key,
   * holding the names, and nowhere for the marks beside them.
   *
   * School levels only: a degree has forty subjects and a transcript, not a
   * box each. `language` is whichever language the student sat — Kannada,
   * Hindi, Sanskrit — because a form asks for "Language", not for one by name.
   * The level-less `education[]` keys are what a form's wording matches;
   * `compose` moves them onto the level the form names.
   */
  'education[].marks_physics',
  'education[].marks_chemistry',
  'education[].marks_mathematics',
  'education[].marks_biology',
  'education[].marks_computer_science',
  'education[].marks_english',
  'education[].marks_language',
  'education[].marks_science',
  'education[].marks_social_science',
  'education.class_10.marks_mathematics',
  'education.class_10.marks_science',
  'education.class_10.marks_social_science',
  'education.class_10.marks_english',
  'education.class_10.marks_language',
  'education.class_12.marks_physics',
  'education.class_12.marks_chemistry',
  'education.class_12.marks_mathematics',
  'education.class_12.marks_biology',
  'education.class_12.marks_computer_science',
  'education.class_12.marks_english',
  'education.class_12.marks_language',

  /*
   * Names as printed in the person's own script — Hindi, Marathi, Telugu,
   * Tamil — which the reader now reads (`documents/ocr.ts`). Kept apart from
   * the English spelling, never instead of it: an English form wants the name
   * the person's English documents use, and a transliteration would be a guess
   * at it. Central and state forms ask for these by name: "Name in Hindi",
   * "Candidate's name in regional language".
   */
  'identity.full_name_local',
  'family.father_name_local',
  'family.mother_name_local',

  /*
   * Off a semester grade card (Stage 3, the table reader): the SGPA it prints,
   * and how many courses on it are not yet cleared — what placement and
   * scholarship forms ask as "SGPA" and "Number of backlogs". The card's own
   * semester is not the current one, so it fills neither `semester` key.
   */
  'education[].sgpa',
  'education[].backlogs',
  'education.diploma.sgpa',
  'education.diploma.backlogs',
  'education.undergraduate.sgpa',
  'education.undergraduate.backlogs',
  'education.postgraduate.sgpa',
  'education.postgraduate.backlogs',

  /*
   * When, and by whom, each claim's certificate was issued (Stage 4, the seal
   * reader): what central EWS and OBC formats and state scholarship portals ask
   * beside the certificate's number — "Date of issue", "Issuing authority". The
   * authority is often printed only in the certificate's seal. A domicile
   * certificate's number, which had no box, has one now.
   */
  'eligibility.caste_certificate_date',
  'eligibility.caste_certificate_authority',
  'eligibility.income_certificate_date',
  'eligibility.income_certificate_authority',
  'eligibility.domicile_certificate_number',
  'eligibility.domicile_certificate_date',
  'eligibility.domicile_certificate_authority',
  'eligibility.article_371j_date',
  'eligibility.article_371j_authority',
] as const;

export type FieldKey = (typeof FIELD_KEYS)[number];

/** The subjects the vault has a marks box for. */
export const MARK_SUBJECTS = [
  'physics',
  'chemistry',
  'mathematics',
  'biology',
  'computer_science',
  'english',
  'language',
  'science',
  'social_science',
] as const;

export type MarkSubject = (typeof MARK_SUBJECTS)[number];

/**
 * The subject a key holds the marks of, or null for any other key.
 *
 * By name, never by the `marks_` prefix alone: `marks_obtained` — the total —
 * begins the same way, and a rule that mistook it for a subject would hide the
 * total from anyone who did not sit a subject called "obtained".
 */
export function markSubjectOf(key: string): MarkSubject | null {
  const segment = key.slice(key.lastIndexOf('.') + 1);
  if (!segment.startsWith('marks_')) return null;
  const subject = segment.slice('marks_'.length);
  return (MARK_SUBJECTS as readonly string[]).includes(subject) ? (subject as MarkSubject) : null;
}

/** The only value the matcher may return that is not a `FieldKey`. */
export const UNKNOWN_KEY = 'unknown' as const;
export type UnknownKey = typeof UNKNOWN_KEY;

export type Sensitivity = 'low' | 'medium' | 'high';

/**
 * Per-key sensitivity (§6.3).
 *
 *   high   — re-auth before fill; never auto-filled from an LLM-only match;
 *            masked in the review UI until revealed; excluded from any log by default.
 *   medium — normal fill; shown in review.
 *   low    — normal fill.
 *
 * Every key in FIELD_KEYS must appear here; `taxonomy.test.ts` enforces that.
 */
export const SENSITIVITY: Readonly<Record<FieldKey, Sensitivity>> = {
  // identity
  'identity.full_name': 'low',
  'identity.given_name': 'low',
  'identity.middle_name': 'low',
  'identity.surname': 'low',
  'identity.dob': 'medium',
  'identity.gender': 'low',
  'identity.category': 'medium',
  'identity.nationality': 'low',
  'identity.marital_status': 'medium',
  'identity.religion': 'medium',
  'identity.mother_tongue': 'low',
  'identity.blood_group': 'medium',

  // family
  'family.father_name': 'low',
  'family.mother_name': 'low',
  'family.guardian_name': 'low',
  'family.father_occupation': 'medium',
  'family.annual_income': 'medium',

  // contact
  'contact.email': 'medium',
  'contact.mobile': 'medium',
  'contact.alt_mobile': 'medium',
  'contact.landline': 'medium',

  // address — permanent
  'address.permanent.line1': 'medium',
  'address.permanent.line2': 'medium',
  'address.permanent.city': 'medium',
  'address.permanent.district': 'medium',
  'address.permanent.state': 'low',
  'address.permanent.pincode': 'medium',
  'address.permanent.country': 'low',

  // address — correspondence
  'address.correspondence.line1': 'medium',
  'address.correspondence.line2': 'medium',
  'address.correspondence.city': 'medium',
  'address.correspondence.district': 'medium',
  'address.correspondence.state': 'low',
  'address.correspondence.pincode': 'medium',
  'address.correspondence.country': 'low',

  // government ids — all high by rule
  'id.aadhaar': 'high',
  'id.pan': 'high',
  'id.passport': 'high',
  'id.voter': 'high',
  'id.driving_licence': 'high',
  'id.abc_id': 'high',
  'id.apaar': 'high',

  // education
  'education[].level': 'low',
  'education[].board_or_university': 'low',
  'education[].institution': 'low',
  'education[].roll_number': 'medium',
  'education[].year_of_passing': 'medium',
  'education[].marks_obtained': 'medium',
  'education[].max_marks': 'medium',
  'education[].percentage': 'medium',
  'education[].cgpa': 'medium',

  // banking — account identifiers are high
  'bank.account_holder': 'medium',
  'bank.account_number': 'high',
  'bank.ifsc': 'high',
  'bank.bank_name': 'medium',
  'bank.branch': 'medium',
  'bank.account_type': 'low',

  // documents — the bytes are the payload; treat identity documents as high
  'doc.photo': 'medium',
  'doc.signature': 'high',
  'doc.aadhaar_card': 'high',
  'doc.pan_card': 'high',
  'doc.marksheet_10': 'medium',
  'doc.marksheet_12': 'medium',
  'doc.degree_certificate': 'medium',
  'doc.income_certificate': 'high',
  'doc.caste_certificate': 'high',
  'doc.domicile_certificate': 'medium',
  'doc.bank_passbook': 'high',
  'doc.disability_certificate': 'high',
  'education[].course': 'low',
  'education[].branch': 'low',
  'education[].specialization': 'low',
  'education[].start_year': 'medium',
  'education[].registration_number': 'medium',
  'education[].subjects': 'low',
  'education[].result_status': 'low',

  // Class 10 / SSLC / Matriculation
  'education.class_10.institution': 'low',
  'education.class_10.board_or_university': 'low',
  'education.class_10.course': 'low',
  'education.class_10.branch': 'low',
  'education.class_10.specialization': 'low',
  'education.class_10.start_year': 'medium',
  'education.class_10.year_of_passing': 'medium',
  'education.class_10.roll_number': 'medium',
  'education.class_10.registration_number': 'medium',
  'education.class_10.marks_obtained': 'medium',
  'education.class_10.max_marks': 'medium',
  'education.class_10.percentage': 'medium',
  'education.class_10.cgpa': 'medium',
  'education.class_10.subjects': 'low',
  'education.class_10.result_status': 'low',

  // Class 12 / HSC / Intermediate
  'education.class_12.institution': 'low',
  'education.class_12.board_or_university': 'low',
  'education.class_12.course': 'low',
  'education.class_12.branch': 'low',
  'education.class_12.specialization': 'low',
  'education.class_12.start_year': 'medium',
  'education.class_12.year_of_passing': 'medium',
  'education.class_12.roll_number': 'medium',
  'education.class_12.registration_number': 'medium',
  'education.class_12.marks_obtained': 'medium',
  'education.class_12.max_marks': 'medium',
  'education.class_12.percentage': 'medium',
  'education.class_12.cgpa': 'medium',
  'education.class_12.subjects': 'low',
  'education.class_12.result_status': 'low',

  // Diploma / Polytechnic
  'education.diploma.institution': 'low',
  'education.diploma.board_or_university': 'low',
  'education.diploma.course': 'low',
  'education.diploma.branch': 'low',
  'education.diploma.specialization': 'low',
  'education.diploma.start_year': 'medium',
  'education.diploma.year_of_passing': 'medium',
  'education.diploma.roll_number': 'medium',
  'education.diploma.registration_number': 'medium',
  'education.diploma.marks_obtained': 'medium',
  'education.diploma.max_marks': 'medium',
  'education.diploma.percentage': 'medium',
  'education.diploma.cgpa': 'medium',
  'education.diploma.subjects': 'low',
  'education.diploma.result_status': 'low',

  // Undergraduate degree
  'education.undergraduate.institution': 'low',
  'education.undergraduate.board_or_university': 'low',
  'education.undergraduate.course': 'low',
  'education.undergraduate.branch': 'low',
  'education.undergraduate.specialization': 'low',
  'education.undergraduate.start_year': 'medium',
  'education.undergraduate.year_of_passing': 'medium',
  'education.undergraduate.roll_number': 'medium',
  'education.undergraduate.registration_number': 'medium',
  'education.undergraduate.marks_obtained': 'medium',
  'education.undergraduate.max_marks': 'medium',
  'education.undergraduate.percentage': 'medium',
  'education.undergraduate.cgpa': 'medium',
  'education.undergraduate.subjects': 'low',
  'education.undergraduate.result_status': 'low',

  // Postgraduate degree
  'education.postgraduate.institution': 'low',
  'education.postgraduate.board_or_university': 'low',
  'education.postgraduate.course': 'low',
  'education.postgraduate.branch': 'low',
  'education.postgraduate.specialization': 'low',
  'education.postgraduate.start_year': 'medium',
  'education.postgraduate.year_of_passing': 'medium',
  'education.postgraduate.roll_number': 'medium',
  'education.postgraduate.registration_number': 'medium',
  'education.postgraduate.marks_obtained': 'medium',
  'education.postgraduate.max_marks': 'medium',
  'education.postgraduate.percentage': 'medium',
  'education.postgraduate.cgpa': 'medium',
  'education.postgraduate.subjects': 'low',
  'education.postgraduate.result_status': 'low',

  // Professional degree
  'education.professional_degree.institution': 'low',
  'education.professional_degree.board_or_university': 'low',
  'education.professional_degree.course': 'low',
  'education.professional_degree.branch': 'low',
  'education.professional_degree.specialization': 'low',
  'education.professional_degree.start_year': 'medium',
  'education.professional_degree.year_of_passing': 'medium',
  'education.professional_degree.roll_number': 'medium',
  'education.professional_degree.registration_number': 'medium',
  'education.professional_degree.marks_obtained': 'medium',
  'education.professional_degree.max_marks': 'medium',
  'education.professional_degree.percentage': 'medium',
  'education.professional_degree.cgpa': 'medium',
  'education.professional_degree.subjects': 'low',
  'education.professional_degree.result_status': 'low',

  // Doctorate / PhD
  'education.phd.institution': 'low',
  'education.phd.board_or_university': 'low',
  'education.phd.course': 'low',
  'education.phd.branch': 'low',
  'education.phd.specialization': 'low',
  'education.phd.start_year': 'medium',
  'education.phd.year_of_passing': 'medium',
  'education.phd.roll_number': 'medium',
  'education.phd.registration_number': 'medium',
  'education.phd.marks_obtained': 'medium',
  'education.phd.max_marks': 'medium',
  'education.phd.percentage': 'medium',
  'education.phd.cgpa': 'medium',
  'education.phd.subjects': 'low',
  'education.phd.result_status': 'low',

  // eligibility and reservation
  'eligibility.caste': 'medium',
  'eligibility.subcategory': 'medium',
  'eligibility.obc_ncl': 'medium',
  'eligibility.ews': 'medium',
  'eligibility.pwbd': 'medium',
  'eligibility.disability_type': 'medium',
  'eligibility.disability_percentage': 'medium',
  'eligibility.udid': 'high',
  'eligibility.domicile_state': 'medium',
  'eligibility.local_status': 'medium',
  'eligibility.minority': 'medium',
  'eligibility.defence_ward': 'low',
  'eligibility.ex_serviceman': 'low',
  'eligibility.sports_quota': 'low',
  'eligibility.ncc': 'low',
  'eligibility.nss': 'low',
  'eligibility.orphan': 'medium',
  'eligibility.age_relaxation': 'medium',

  // emergency contact
  'emergency.name': 'low',
  'emergency.relation': 'low',
  'emergency.mobile': 'medium',

  // parents' contact and the applicant's other emails
  'family.father_mobile': 'medium',
  'family.mother_mobile': 'medium',
  'family.guardian_mobile': 'medium',
  'family.father_email': 'medium',
  'family.mother_email': 'medium',
  'family.guardian_email': 'medium',
  'contact.alt_email': 'medium',
  'contact.official_email': 'medium',
  // documents — a student's own folders
  'doc.voter_id': 'high',
  'doc.birth_certificate': 'high',
  'doc.passport': 'high',
  'doc.driving_licence': 'high',
  'doc.passing_certificate': 'medium',
  'doc.passing_certificate_10': 'medium',
  'doc.passing_certificate_12': 'medium',
  'doc.study_certificate': 'medium',
  'doc.study_certificate_10': 'medium',
  'doc.study_certificate_12': 'medium',
  'doc.transfer_certificate': 'medium',
  'doc.transfer_certificate_10': 'medium',
  'doc.transfer_certificate_12': 'medium',
  'doc.migration_certificate': 'medium',
  'doc.migration_certificate_10': 'medium',
  'doc.migration_certificate_12': 'medium',
  'doc.conduct_certificate': 'medium',
  'doc.marksheet_11': 'medium',
  // Names a caste and a region, like the caste certificate it rests on.
  'doc.article_371j_certificate': 'high',

  // documents — entrance exam and admission
  'doc.entrance_application_form': 'medium',
  'doc.entrance_fee_receipt': 'medium',
  'doc.entrance_admission_ticket': 'medium',
  'doc.entrance_result': 'medium',
  'doc.entrance_rank_card': 'medium',
  'doc.entrance_verification_slip': 'medium',
  'doc.entrance_claim_verification': 'medium',
  'doc.entrance_option_entry': 'medium',
  'doc.seat_allotment_letter': 'medium',
  'doc.admission_fee_receipt': 'medium',
  'doc.admission_order': 'medium',

  // A thumb impression is biometric: it is treated as strictly as a signature.
  'doc.thumb_impression': 'high',
  'doc.scholarship_application': 'medium',

  'eligibility.caste_certificate_number': 'medium',
  'eligibility.income_certificate_number': 'medium',
  'eligibility.article_371j_number': 'medium',
  // documents — the current course
  'doc.semester_marksheet': 'medium',
  'doc.consolidated_marksheet': 'medium',
  'doc.bonafide_certificate': 'medium',
  'doc.college_id_card': 'medium',
  'doc.admission_letter': 'medium',

  // documents — reservation, per category: as sensitive as the caste they name
  'doc.caste_certificate_form_d': 'high',
  'doc.ews_certificate': 'high',
  'doc.obc_certificate': 'high',

  // documents — work and skills. A resume carries an address and a phone
  // number; a workshop certificate carries a name and a date.
  'doc.resume': 'medium',
  'doc.internship_offer_letter': 'medium',
  'doc.internship_certificate': 'medium',
  'doc.experience_certificate': 'medium',
  'doc.recommendation_letter': 'medium',
  'doc.course_certificate': 'low',
  'doc.training_certificate': 'low',
  'doc.workshop_certificate': 'low',
  'doc.professional_certification': 'low',
  'doc.hackathon_certificate': 'low',
  'doc.competition_certificate': 'low',
  'doc.achievement_certificate': 'low',
  'doc.project_report': 'low',
  'doc.project_certificate': 'low',
  'doc.publication': 'low',
  'doc.patent_document': 'low',
  'doc.sports_certificate': 'low',
  'doc.ncc_certificate': 'low',
  'doc.nss_certificate': 'low',
  'doc.volunteering_certificate': 'low',

  'doc.iti_marksheet': 'medium',
  'doc.iti_certificate': 'medium',

  'education[].semester': 'low',
  'education[].year_of_study': 'low',
  'education.diploma.semester': 'low',
  'education.diploma.year_of_study': 'low',
  'education.undergraduate.semester': 'low',
  'education.undergraduate.year_of_study': 'low',
  'education.postgraduate.semester': 'low',
  'education.postgraduate.year_of_study': 'low',

  'entrance.exam_name': 'low',
  'entrance.registration_number': 'medium',
  'entrance.roll_number': 'medium',
  'entrance.rank': 'low',
  'entrance.score': 'low',
  'entrance.year': 'low',

  'eligibility.article_371j': 'medium',

  // As sensitive as the district it sits beside: part of an address, not an
  // identifier.
  'address.permanent.taluk': 'medium',
  'address.correspondence.taluk': 'medium',

  // Marks are what a marks card prints; nothing here identifies anybody.
  'education[].marks_physics': 'low',
  'education[].marks_chemistry': 'low',
  'education[].marks_mathematics': 'low',
  'education[].marks_biology': 'low',
  'education[].marks_computer_science': 'low',
  'education[].marks_english': 'low',
  'education[].marks_language': 'low',
  'education[].marks_science': 'low',
  'education[].marks_social_science': 'low',
  'education.class_10.marks_mathematics': 'low',
  'education.class_10.marks_science': 'low',
  'education.class_10.marks_social_science': 'low',
  'education.class_10.marks_english': 'low',
  'education.class_10.marks_language': 'low',
  'education.class_12.marks_physics': 'low',
  'education.class_12.marks_chemistry': 'low',
  'education.class_12.marks_mathematics': 'low',
  'education.class_12.marks_biology': 'low',
  'education.class_12.marks_computer_science': 'low',
  'education.class_12.marks_english': 'low',
  'education.class_12.marks_language': 'low',
  'identity.full_name_local': 'low',
  'family.father_name_local': 'low',
  'family.mother_name_local': 'low',
  'education[].sgpa': 'medium',
  'education[].backlogs': 'medium',
  'education.diploma.sgpa': 'medium',
  'education.diploma.backlogs': 'medium',
  'education.undergraduate.sgpa': 'medium',
  'education.undergraduate.backlogs': 'medium',
  'education.postgraduate.sgpa': 'medium',
  'education.postgraduate.backlogs': 'medium',
  'eligibility.caste_certificate_date': 'medium',
  'eligibility.caste_certificate_authority': 'medium',
  'eligibility.income_certificate_date': 'medium',
  'eligibility.income_certificate_authority': 'medium',
  'eligibility.domicile_certificate_number': 'medium',
  'eligibility.domicile_certificate_date': 'medium',
  'eligibility.domicile_certificate_authority': 'medium',
  'eligibility.article_371j_date': 'medium',
  'eligibility.article_371j_authority': 'medium',
};

/**
 * Retired key -> current key. Populated only when a key is superseded; rule 1
 * above means we never delete or rename an entry in FIELD_KEYS.
 */
export const KEY_ALIASES: Readonly<Record<string, FieldKey>> = {};

/** Keys whose value is a document blob rather than a string. */
export const DOCUMENT_KEY_PREFIX = 'doc.';

/** Keys that belong to a repeatable row group (e.g. one per qualification). */
export const REPEATABLE_MARKER = '[]';

const FIELD_KEY_SET: ReadonlySet<string> = new Set<string>(FIELD_KEYS);

export function isFieldKey(value: string): value is FieldKey {
  return FIELD_KEY_SET.has(value);
}

export function isDocumentKey(key: FieldKey): boolean {
  return key.startsWith(DOCUMENT_KEY_PREFIX);
}

export function isRepeatableKey(key: FieldKey): boolean {
  return key.includes(REPEATABLE_MARKER);
}

export function sensitivityOf(key: FieldKey): Sensitivity {
  return SENSITIVITY[key];
}

/** Resolve a possibly-retired key to its current form, or `undefined`. */
export function resolveKey(value: string): FieldKey | undefined {
  if (isFieldKey(value)) return value;
  return KEY_ALIASES[value];
}
