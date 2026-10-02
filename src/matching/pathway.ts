/**
 * A person's own education, and what it means for their vault (§ vault structure).
 *
 * The taxonomy is everything anybody might be asked for. This module decides
 * which of it *one* person is offered: a Karnataka student who went CBSE Class
 * 10 → PUC → B.Tech through KCET has no diploma, no doctorate, and no ITI
 * trade certificate, and the seven qualification blocks and nine document
 * folders they were shown were mostly somebody else's.
 *
 * Two rules hold the whole design together:
 *
 *  1. **It decides what is offered, never what is possible.** Every key stays
 *     in the taxonomy, the matcher still knows them all, and the panels keep a
 *     "show everything" control. A path answered wrongly costs a click.
 *  2. **A key that holds something is never hidden.** The panels union what is
 *     offered with what is already filled, so no answer here can take a user's
 *     own data off their screen.
 *
 * Pure and free of any UI import, so the rules can be read and tested as
 * rules; `ui/lib/vault-shape.ts` is what turns them into groups on a screen.
 */

import { FIELD_KEYS, isFieldKey, markSubjectOf, type FieldKey } from './taxonomy';

// ---------------------------------------------------------------------------
// The answers
// ---------------------------------------------------------------------------

export const BOARDS = ['cbse', 'state', 'icse', 'other'] as const;
export const AFTER_TEN = ['puc', 'diploma', 'iti', 'none'] as const;
export const STREAMS = ['pcm', 'pcb', 'pcmb', 'pcm-cs', 'commerce', 'arts', 'other'] as const;
export const STAGES = [
  'class_12',
  'diploma',
  'iti',
  'undergraduate',
  'postgraduate',
  'graduated',
] as const;
export const DEGREE_FAMILIES = [
  'engineering',
  'medical',
  'commerce',
  'arts',
  'science',
  'law',
  'design',
  'other',
] as const;
export const ENTRANCE_EXAMS = ['kcet', 'comedk', 'jee', 'neet', 'cuet', 'other'] as const;
export const CATEGORIES = ['gm', 'sc', 'st', 'obc', 'ews'] as const;
export const CLAIMS = [
  '371j',
  'income',
  'domicile',
  'pwbd',
  'minority',
  'sports',
  'ncc',
  'nss',
] as const;

export type Board = (typeof BOARDS)[number];
export type AfterTen = (typeof AFTER_TEN)[number];
export type Stream = (typeof STREAMS)[number];
export type Stage = (typeof STAGES)[number];
export type DegreeFamily = (typeof DEGREE_FAMILIES)[number];
export type EntranceExam = (typeof ENTRANCE_EXAMS)[number];
export type Category = (typeof CATEGORIES)[number];
export type Claim = (typeof CLAIMS)[number];

export interface AcademicPath {
  version: 1;
  /** Lower-case state name, or null. Karnataka is what makes 371(J) sensible. */
  state: string | null;
  board10: Board;
  afterTen: AfterTen;
  stream: Stream | null;
  /** Where the person is now, which decides how far the vault reaches. */
  now: Stage;
  degreeFamily: DegreeFamily | null;
  /**
   * The degree itself, and the branch of it — "B.E. / B.Tech", "Computer
   * Science Engineering".
   *
   * Free text, suggested from `courses.ts`. They shape nothing: they are here
   * so the setup card can write them into the qualification block, where a
   * form fills from them. A path stored before this existed has neither, and
   * reads back with both null.
   */
  course: string | null;
  branch: string | null;
  entrance: EntranceExam[];
  category: Category;
  claims: Claim[];
}

/**
 * What somebody has before they answer anything: school, and nothing claimed.
 *
 * Deliberately the smallest honest path rather than the largest — a person who
 * skips the questions sees a short vault they can add to, not the long one the
 * questions exist to shorten. Skipping entirely stores no path at all, which
 * the panels read as "show everything".
 */
export function defaultPath(): AcademicPath {
  return {
    version: 1,
    state: null,
    board10: 'state',
    afterTen: 'puc',
    stream: null,
    now: 'class_12',
    degreeFamily: null,
    course: null,
    branch: null,
    entrance: [],
    category: 'gm',
    claims: [],
  };
}

// ---------------------------------------------------------------------------
// Reading one back
// ---------------------------------------------------------------------------

function oneOf<T extends string>(allowed: readonly T[], value: unknown): T | null {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : null;
}

/** A free-text answer: the string, null for none, `false` for "not a string". */
function readText(value: unknown): string | null | false {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed.slice(0, 120);
}

/**
 * Read a stored path, or answer null.
 *
 * It comes back out of the vault, and it shapes the whole editor, so a value
 * that is not one of the answers offered is refused rather than guessed at.
 * The one thing it is lenient about is a *list* entry it does not recognise —
 * a claim added by a later build is dropped, and the rest of the path opens,
 * because a vault must not become unreadable by being opened in an older
 * build than the one that wrote it.
 */
export function parsePath(value: unknown): AcademicPath | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = value as Record<string, unknown>;
  if (raw.version !== 1) return null;

  const board10 = oneOf(BOARDS, raw.board10);
  const afterTen = oneOf(AFTER_TEN, raw.afterTen);
  const now = oneOf(STAGES, raw.now);
  const category = oneOf(CATEGORIES, raw.category);
  if (board10 === null || afterTen === null || now === null || category === null) return null;
  if (!Array.isArray(raw.entrance) || !Array.isArray(raw.claims)) return null;
  if (raw.state !== null && typeof raw.state !== 'string') return null;
  // Added after the first paths were written, so absent is as valid as null.
  const course = readText(raw.course);
  const branch = readText(raw.branch);
  if (course === false || branch === false) return null;

  // Lists drop what they do not recognise; the single-answer fields above do
  // not. An exam or a claim added by a later build is a thing this build has
  // no rule for, and ignoring one entry is honest. A *category* it cannot read
  // is different: there is no safe reading of "which reservation is claimed".
  const entrance = raw.entrance
    .map((entry) => oneOf(ENTRANCE_EXAMS, entry))
    .filter((entry): entry is EntranceExam => entry !== null);

  const claims = raw.claims
    .map((entry) => oneOf(CLAIMS, entry))
    .filter((entry): entry is Claim => entry !== null);

  return {
    version: 1,
    state: (raw.state as string | null) ?? null,
    board10,
    afterTen,
    stream: oneOf(STREAMS, raw.stream),
    now,
    degreeFamily: oneOf(DEGREE_FAMILIES, raw.degreeFamily),
    course,
    branch,
    entrance,
    category,
    claims,
  };
}

// ---------------------------------------------------------------------------
// What it implies
// ---------------------------------------------------------------------------

/** Qualification blocks, in the order a person earns them. */
export function qualificationPrefixesFor(path: AcademicPath): string[] {
  const prefixes = ['education.class_10.'];

  if (path.afterTen === 'puc') prefixes.push('education.class_12.');
  if (path.afterTen === 'diploma') prefixes.push('education.diploma.');

  const reachedCollege =
    path.now === 'undergraduate' || path.now === 'postgraduate' || path.now === 'graduated';
  if (reachedCollege) prefixes.push('education.undergraduate.');
  if (path.now === 'postgraduate') prefixes.push('education.postgraduate.');

  return prefixes;
}

/** The exams whose papers a person holds — an empty list means no entrance folder. */
function satAnEntranceExam(path: AcademicPath): boolean {
  return path.entrance.length > 0;
}

const ALWAYS_DOCUMENTS: readonly string[] = [
  // Asked for by nearly every form.
  'doc.photo',
  'doc.signature',
  'doc.thumb_impression',
  // Identity.
  'doc.aadhaar_card',
  'doc.pan_card',
  'doc.voter_id',
  'doc.birth_certificate',
  'doc.passport',
  'doc.driving_licence',
  // School: everybody has been.
  'doc.marksheet_10',
  'doc.passing_certificate_10',
  'doc.study_certificate_10',
  'doc.transfer_certificate_10',
  'doc.migration_certificate_10',
  // The level-less fallbacks, for a portal that names no qualification.
  'doc.study_certificate',
  'doc.transfer_certificate',
  'doc.passing_certificate',
  'doc.migration_certificate',
  // Money.
  'doc.bank_passbook',
  'doc.scholarship_application',
];

const PUC_DOCUMENTS: readonly string[] = [
  'doc.marksheet_11',
  'doc.marksheet_12',
  'doc.passing_certificate_12',
  'doc.study_certificate_12',
  'doc.transfer_certificate_12',
  'doc.migration_certificate_12',
  'doc.conduct_certificate',
];

/** Issued by the institution somebody is at, while they are still at it. */
const COURSE_DOCUMENTS: readonly string[] = [
  'doc.semester_marksheet',
  'doc.consolidated_marksheet',
  'doc.bonafide_certificate',
  'doc.college_id_card',
  'doc.admission_letter',
];

/**
 * What a student collects beside their marks.
 *
 * Offered from the first tertiary course onwards, because that is when a
 * portal starts asking for them — a scholarship wants the bonafide and the
 * semester marks card, an internship wants the resume and the certificates.
 */
const PORTFOLIO_DOCUMENTS: readonly string[] = [
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
  'doc.volunteering_certificate',
];

const ITI_DOCUMENTS: readonly string[] = ['doc.iti_marksheet', 'doc.iti_certificate'];

const ENTRANCE_DOCUMENTS: readonly string[] = [
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
];

/** The certificate each claim rests on. */
const CLAIM_DOCUMENTS: Readonly<Record<Claim, readonly string[]>> = {
  '371j': ['doc.article_371j_certificate'],
  income: ['doc.income_certificate'],
  domicile: ['doc.domicile_certificate'],
  pwbd: ['doc.disability_certificate'],
  minority: [],
  // A quota is claimed with the certificate that proves it, so the slot
  // appears with the claim rather than for everybody.
  sports: ['doc.sports_certificate'],
  ncc: ['doc.ncc_certificate'],
  nss: ['doc.nss_certificate'],
};

/** The caste certificate a category is actually issued. */
function categoryDocumentsFor(path: AcademicPath): readonly string[] {
  switch (path.category) {
    case 'sc':
    case 'st':
      // Form-D is Karnataka's own SC/ST form, asked for by KEA beside the
      // ordinary certificate; elsewhere it is a form nobody has.
      return path.state === 'karnataka'
        ? ['doc.caste_certificate', 'doc.caste_certificate_form_d']
        : ['doc.caste_certificate'];
    case 'obc':
      return ['doc.caste_certificate', 'doc.obc_certificate'];
    case 'ews':
      return ['doc.ews_certificate'];
    case 'gm':
      return [];
  }
}

/** Somebody who has started a course beyond school. */
function inTertiary(path: AcademicPath): boolean {
  return (
    path.now === 'diploma' ||
    path.now === 'iti' ||
    path.now === 'undergraduate' ||
    path.now === 'postgraduate' ||
    path.now === 'graduated'
  );
}

/** Document slots this person is offered. */
export function documentKeysFor(path: AcademicPath): Set<FieldKey> {
  const keys = new Set<string>(ALWAYS_DOCUMENTS);

  if (path.afterTen === 'puc') for (const key of PUC_DOCUMENTS) keys.add(key);
  if (satAnEntranceExam(path)) for (const key of ENTRANCE_DOCUMENTS) keys.add(key);
  if (path.afterTen === 'iti' || path.now === 'iti') for (const key of ITI_DOCUMENTS) keys.add(key);

  if (inTertiary(path)) {
    for (const key of COURSE_DOCUMENTS) keys.add(key);
    for (const key of PORTFOLIO_DOCUMENTS) keys.add(key);
  }

  // A degree certificate arrives with the degree. A fourth-year student holds
  // semester marks cards and no certificate, and an empty slot labelled
  // "Degree certificate" is a slot that reads as something forgotten.
  if (path.now === 'graduated' || path.now === 'postgraduate') keys.add('doc.degree_certificate');

  // A caste certificate belongs to a category that has one.
  for (const key of categoryDocumentsFor(path)) keys.add(key);
  for (const claim of path.claims) for (const key of CLAIM_DOCUMENTS[claim]) keys.add(key);

  return onlyRealKeys(keys);
}

/** Profile blocks everybody is asked for, whatever they have studied. */
const ALWAYS_FIELD_PREFIXES: readonly string[] = [
  'identity.',
  'family.',
  'contact.',
  'address.permanent.',
  'address.correspondence.',
  'id.',
  'emergency.',
  'bank.',
];

/** The questions each claim brings with it. */
const CLAIM_FIELDS: Readonly<Record<Claim, readonly string[]>> = {
  '371j': ['eligibility.article_371j', 'eligibility.article_371j_number'],
  income: ['eligibility.income_certificate_number', 'family.annual_income'],
  domicile: ['eligibility.domicile_state', 'eligibility.local_status'],
  pwbd: [
    'eligibility.pwbd',
    'eligibility.disability_type',
    'eligibility.disability_percentage',
    'eligibility.udid',
  ],
  minority: ['eligibility.minority'],
  sports: ['eligibility.sports_quota'],
  ncc: ['eligibility.ncc'],
  nss: ['eligibility.nss'],
};

const CATEGORY_FIELDS: Readonly<Record<Category, readonly string[]>> = {
  gm: [],
  sc: ['eligibility.caste', 'eligibility.subcategory', 'eligibility.caste_certificate_number'],
  st: ['eligibility.caste', 'eligibility.subcategory', 'eligibility.caste_certificate_number'],
  obc: [
    'eligibility.caste',
    'eligibility.subcategory',
    'eligibility.obc_ncl',
    'eligibility.caste_certificate_number',
  ],
  ews: ['eligibility.ews', 'eligibility.income_certificate_number'],
};

/**
 * Profile fields this person is offered.
 *
 * `eligibility.*` is the block this narrows hardest: twenty-one questions, of
 * which an ordinary applicant answers two or three, and the ones that do not
 * apply are not merely unanswered — a portal that reads them would be told
 * something untrue about who is claiming what.
 */
export function fieldKeysFor(path: AcademicPath): Set<FieldKey> {
  const keys = new Set<string>();

  for (const prefix of [...ALWAYS_FIELD_PREFIXES, ...qualificationPrefixesFor(path)]) {
    for (const key of FIELD_KEYS) if (key.startsWith(prefix)) keys.add(key);
  }

  // The entrance exam's own numbers: a registration number and a rank belong
  // to somebody who sat one, and to nobody else.
  if (satAnEntranceExam(path)) {
    for (const key of FIELD_KEYS) if (key.startsWith('entrance.')) keys.add(key);
  }

  for (const key of CATEGORY_FIELDS[path.category]) keys.add(key);
  for (const claim of path.claims) for (const key of CLAIM_FIELDS[claim]) keys.add(key);

  // A box for each subject the person sat at Class 12, and no others.
  const sat = SUBJECTS_FOR_STREAM[path.stream ?? 'other'];
  if (sat !== null) {
    for (const key of [...keys]) {
      if (!key.startsWith('education.class_12.')) continue;
      const subject = markSubjectOf(key);
      if (subject !== null && !sat.has(subject)) keys.delete(key);
    }
  }

  return onlyRealKeys(keys);
}

/**
 * The Class 12 subjects each stream sits, of those the vault has a box for.
 *
 * English and a language are sat by everyone. `null` means "not known" — no
 * stream was given, or "other" — and that is an answer of *everything*, never
 * of nothing: the same rule as a vault with no path at all. Commerce and Arts
 * have no subject boxes of their own yet, so they are offered the two
 * languages and told nothing untrue.
 */
const SUBJECTS_FOR_STREAM: Readonly<Record<Stream, ReadonlySet<string> | null>> = {
  pcm: new Set(['physics', 'chemistry', 'mathematics', 'english', 'language']),
  pcb: new Set(['physics', 'chemistry', 'biology', 'english', 'language']),
  pcmb: new Set(['physics', 'chemistry', 'mathematics', 'biology', 'english', 'language']),
  'pcm-cs': new Set(['physics', 'chemistry', 'mathematics', 'computer_science', 'english', 'language']),
  commerce: new Set(['english', 'language']),
  arts: new Set(['english', 'language']),
  other: null,
};

/**
 * Nothing leaves here that the taxonomy does not have.
 *
 * The lists above are written by hand, and a typo in one of them would put a
 * key on screen that no form can ever match and no vault can ever store.
 */
function onlyRealKeys(keys: Iterable<string>): Set<FieldKey> {
  const real = new Set<FieldKey>();
  for (const key of keys) if (isFieldKey(key)) real.add(key);
  return real;
}

// ---------------------------------------------------------------------------
// Saying it back
// ---------------------------------------------------------------------------

const BOARD_WORDS: Readonly<Record<Board, string>> = {
  cbse: 'CBSE',
  state: 'State board',
  icse: 'ICSE',
  other: 'School',
};

const AFTER_TEN_WORDS: Readonly<Record<AfterTen, string>> = {
  puc: 'PUC / Class 12',
  diploma: 'Diploma',
  iti: 'ITI',
  none: 'no further study yet',
};

const STREAM_WORDS: Readonly<Record<Stream, string>> = {
  pcm: 'Science PCM',
  pcb: 'Science PCB',
  pcmb: 'Science PCMB',
  'pcm-cs': 'Science PCM + Computer Science',
  commerce: 'Commerce',
  arts: 'Arts',
  other: 'other stream',
};

const STAGE_WORDS: Readonly<Record<Stage, string>> = {
  class_12: 'in PUC / Class 12',
  diploma: 'in a diploma',
  iti: 'in an ITI trade',
  undergraduate: 'reading for a degree',
  postgraduate: 'reading for a postgraduate degree',
  graduated: 'graduated',
};

const EXAM_WORDS: Readonly<Record<EntranceExam, string>> = {
  kcet: 'KCET',
  comedk: 'COMEDK',
  jee: 'JEE',
  neet: 'NEET',
  cuet: 'CUET',
  other: 'an entrance exam',
};

const CLAIM_WORDS: Readonly<Record<Claim, string>> = {
  '371j': '371(J)',
  income: 'income certificate',
  domicile: 'domicile',
  pwbd: 'PwBD',
  minority: 'minority',
  sports: 'sports quota',
  ncc: 'NCC',
  nss: 'NSS',
};

const CATEGORY_WORDS: Readonly<Record<Category, string>> = {
  gm: 'General merit',
  sc: 'SC',
  st: 'ST',
  obc: 'OBC',
  ews: 'EWS',
};

/** One line the person can check at a glance, and correct if it is wrong. */
export function describePath(path: AcademicPath): string {
  const steps = [`${BOARD_WORDS[path.board10]} Class 10`];

  const after = AFTER_TEN_WORDS[path.afterTen];
  steps.push(path.stream === null ? after : `${after} (${STREAM_WORDS[path.stream]})`);

  if (path.now === 'undergraduate' || path.now === 'postgraduate' || path.now === 'graduated') {
    const degree = [path.course, path.branch].filter((part) => part !== null).join(' — ');
    steps.push(degree === '' ? STAGE_WORDS[path.now] : degree);
  }

  const tail = [CATEGORY_WORDS[path.category]];
  if (path.entrance.length > 0) {
    tail.unshift(path.entrance.map((exam) => EXAM_WORDS[exam]).join(', '));
  }
  for (const claim of path.claims) tail.push(CLAIM_WORDS[claim]);

  return `${steps.join(' → ')} · ${tail.join(' · ')}`;
}
