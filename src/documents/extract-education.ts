/**
 * Reading a marks card (§ reading a document).
 *
 * The one document every portal asks for, and the one with the most on it: a
 * board, a school, a register number, a table of subjects, a total, a result.
 * Everything here is a *candidate* — the user ticks what to keep, as with
 * every other rule in `extract.ts`.
 *
 * **Which qualification it belongs to comes from the vault, not the card.**
 * "S.S.L.C." is Karnataka's word for Class 10, "CLASS X" is CBSE's, a PUC card
 * says "II PUC" and a semester card says neither. Guessing wrongly files Class
 * 10 marks under Class 12, which is worse than filing nothing — so without the
 * slot the document was saved in, these rules stay silent.
 *
 * **Two things it will not do**, because the taxonomy has nowhere honest to
 * put them:
 *
 *  - *The school's address.* There is no key for an institution's address, and
 *    the applicant's own address must never take it — a school in Tumkur is
 *    not where the student lives.
 *  - *Marks per subject.* There is one `subjects` key, so the subjects are
 *    listed in the order the card prints them and the totals go to
 *    `marks_obtained` and `max_marks`.
 */

import type { FieldKey, MarkSubject } from '@/matching/taxonomy';
import { isFieldKey } from '@/matching/taxonomy';
import { labelledValue, type Ctx } from './extract';

/**
 * The qualification block a document slot belongs to.
 *
 * Only the slots that carry marks. A transfer certificate is filed under the
 * same qualification but carries no marks, so it is not here.
 */
const BLOCK_FOR_SLOT: Readonly<Record<string, string>> = {
  'doc.marksheet_10': 'education.class_10.',
  'doc.passing_certificate_10': 'education.class_10.',
  'doc.marksheet_11': 'education.class_12.',
  'doc.marksheet_12': 'education.class_12.',
  'doc.passing_certificate_12': 'education.class_12.',
  'doc.semester_marksheet': 'education.undergraduate.',
  'doc.consolidated_marksheet': 'education.undergraduate.',
  'doc.degree_certificate': 'education.undergraduate.',
  'doc.iti_marksheet': 'education.diploma.',
  'doc.iti_certificate': 'education.diploma.',
  /*
   * Not marks cards, but issued per qualification and printing the same two
   * things a portal asks about a school: its name, and the number the student
   * sat under. Only the level-named slots are here — a plain
   * `doc.study_certificate` names no qualification, and a level must never be
   * guessed (`matching/frame.ts` holds the same rule for questions).
   */
  'doc.study_certificate_10': 'education.class_10.',
  'doc.study_certificate_12': 'education.class_12.',
  'doc.transfer_certificate_10': 'education.class_10.',
  'doc.transfer_certificate_12': 'education.class_12.',
  'doc.migration_certificate_10': 'education.class_10.',
  'doc.migration_certificate_12': 'education.class_12.',
};

/** Labels, in the words the boards actually print. */
const BOARD_LABEL =
  /^(?:board|board\s*\/\s*university|university|examining\s+authority|name of (?:the )?board)\s*[:-]?\s*(.*)$/i;
/*
 * "College", but never "College Code No." — a 2nd PUC certificate prints both,
 * and the code was once filed as the institution's name.
 */
const SCHOOL_LABEL =
  /^(?:school|school\s*name|name of (?:the )?(?:school|institution|college)|institution|college(?!\s*code))\s*[:-]?\s*(.*)$/i;
const REGISTER_LABEL =
  /^(?:register(?:ed)?\s*(?:no\.?|number)|registration\s*(?:no\.?|number)|reg\.?\s*no\.?)\s*[:-]?\s*(.*)$/i;
const ROLL_LABEL = /^(?:roll\s*(?:no\.?|number)|seat\s*(?:no\.?|number))\s*[:-]?\s*(.*)$/i;
const RESULT_LABEL = /^(?:result|result\s*status|division)\s*[:-]?\s*(.*)$/i;
const PERCENTAGE_LABEL = /^(?:percentage|percentage of marks|per\s*cent(?:age)?)\s*[:-]?\s*(.*)$/i;
const YEAR_LABEL =
  /^(?:year(?: of)?(?: passing| of passing| of examination)?|month\s*(?:&|and|\/)?\s*year|exam(?:ination)?\s*year)\s*[:-]?\s*(.*)$/i;

/**
 * The school's address, which belongs to the school.
 *
 * Either labelled as such, or a school line with a PIN code sitting in it.
 * Recognised only so that it can be reported and left alone.
 */
const SCHOOL_ADDRESS_LINE =
  /^(?:(?:school|institution|college)\s*address|address of (?:the )?(?:school|institution|college))\b|^(?:school|institution|college)\b.*(?<![0-9])[1-9][0-9]{5}(?![0-9])/i;

/** A board or a school is a line of words, not a number or a caption. */
function looksLikeInstitution(value: string): boolean {
  const trimmed = value.trim();
  return (
    trimmed.length >= 4 &&
    trimmed.length <= 120 &&
    /[A-Za-z]{3}/.test(trimmed) &&
    // A second label on the same line — "Code No. : CC0123" — is not a name.
    !trimmed.includes(' : ')
  );
}

/** A register or roll number: digits, sometimes with a letter or two. */
function looksLikeNumber(value: string): boolean {
  const trimmed = value.trim();
  return /^[A-Z]{0,3}[0-9][0-9A-Z/-]{3,19}$/i.test(trimmed);
}

/** Words a board prints for the outcome. */
const RESULT_WORDS =
  /^(pass(?:ed)?|fail(?:ed)?|first class(?: with distinction)?|second class|third class|distinction|promoted|eligible for higher study)$/i;

/**
 * The subject rows of the table, and the numbers on them.
 *
 * A row is a subject when it starts with words and ends with numbers:
 * "MATHEMATICS 100 95", "ENGLISH LANG AND LIT 085 EIGHTY FIVE". The numbers
 * are read left to right, the way the card prints them — a maximum before an
 * obtained mark — and a row with one number has only the mark.
 */
interface SubjectRow {
  subject: string;
  max: number | null;
  obtained: number;
  line: number;
  evidence: string;
}

const NOT_A_SUBJECT =
  /^(?:total|grand total|aggregate|result|percentage|subject|subjects|marks|max|maximum|obtained|register|roll|school|board|student|candidate|father|mother|date|year|month|serial)\b/i;

/**
 * The subject a row is, in the names the boards print.
 *
 * "SOCIAL SCIENCE" before "SCIENCE": the longer name contains the shorter, and
 * a Social Science mark filed as Science is a wrong answer on a form. Any
 * language but English is the student's `language` — a form asks for
 * "Language", not for Kannada by name.
 */
const SUBJECT_NAMES: ReadonlyArray<{ subject: MarkSubject; pattern: RegExp }> = [
  { subject: 'social_science', pattern: /^social\s+(?:science|studies)\b/i },
  { subject: 'computer_science', pattern: /^computer\s+science\b/i },
  { subject: 'science', pattern: /^(?:general\s+)?science\b/i },
  { subject: 'physics', pattern: /^physics\b/i },
  { subject: 'chemistry', pattern: /^chemistry\b/i },
  { subject: 'mathematics', pattern: /^math(?:s|ematics)?\b/i },
  { subject: 'biology', pattern: /^biology\b/i },
  { subject: 'english', pattern: /^english\b/i },
  {
    subject: 'language',
    pattern:
      /^(?:kannada|hindi|sanskrit|telugu|tamil|malayalam|marathi|urdu|bengali|gujarati|punjabi|odia|konkani|tulu|arabic|french|german)\b/i,
  },
];

function subjectOf(name: string): MarkSubject | null {
  return SUBJECT_NAMES.find((entry) => entry.pattern.test(name.trim()))?.subject ?? null;
}

/**
 * The names long enough to mend: seven letters or more, spelled as boards print
 * them. A shorter name — HINDI, MATHS — is one letter from too many other words
 * for a single wrong letter to be told from a different subject.
 */
const MENDABLE = [
  'SOCIAL SCIENCE',
  'COMPUTER SCIENCE',
  'MATHEMATICS',
  'CHEMISTRY',
  'SANSKRIT',
  'PHYSICS',
  'BIOLOGY',
  'ENGLISH',
  'SCIENCE',
  'KANNADA',
] as const;

/** Whether one letter changed, added or dropped turns `a` into `b`. */
function oneEditApart(a: string, b: string): boolean {
  if (a === b || Math.abs(a.length - b.length) > 1) return false;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  let i = 0;
  while (i < short.length && short[i] === long[i]) i += 1;
  // Past the first difference the rest must agree: the same tail for a changed
  // letter, the tail one along for an added one.
  return short.length === long.length
    ? short.slice(i + 1) === long.slice(i + 1)
    : short.slice(i) === long.slice(i + 1);
}

/**
 * A subject name with the reader's one wrong letter put right.
 *
 * Read off a real card: `MAT JEMATICS`, the H taken for a gap and a J. The
 * leading words are joined — the gap is part of the damage — and compared
 * whole against each name, never as a prefix: PHYSICAL is one letter from
 * PHYSICS only if its last letter is ignored, and Physical Education is not
 * Physics. One edit and no more, so GEOLOGY and ZOOLOGY stay what they are.
 */
function mended(subject: string): string {
  if (subjectOf(subject) !== null) return subject;

  const words = subject.split(' ');
  for (let taken = 1; taken <= Math.min(3, words.length); taken += 1) {
    const joined = words.slice(0, taken).join('').replace(/[^A-Za-z]/g, '').toUpperCase();
    for (const name of MENDABLE) {
      if (oneEditApart(joined, name.replace(' ', ''))) return [name, ...words.slice(taken)].join(' ');
    }
  }
  return subject;
}

/**
 * A word of a subject's name, less what print damage put inside it.
 *
 * A figure between letters is a letter the reader took for one — BI0LOGY — and
 * a mark no subject is printed with, between letters, is a broken stroke:
 * MAT!JEMATICS. Only between letters: a full stop or a hyphen at a word's end
 * is how boards abbreviate, and is left alone.
 */
function undamaged(word: string): string {
  return word
    .replace(/(?<=[A-Za-z])0(?=[A-Za-z])/g, 'O')
    .replace(/(?<=[A-Za-z])1(?=[A-Za-z])/g, 'I')
    .replace(/(?<=[A-Za-z])[!|:;'"`*~^_]+(?=[A-Za-z])/g, '');
}

/** A register or roll number repeated in every row: five or more digits. */
const LONG_NUMBER = /^\d{5,}$/;

/** The exam's month, printed in every row of a PUC certificate: "APR2022", "MAR-2019". */
const MONTH_YEAR = /^(?:JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|SEPT|OCT|NOV|DEC)[A-Z]*[-/]?(?:19|20)?\d{2}$/i;

/**
 * The subject rows of a marks table, whatever columns the board prints.
 *
 * Three shapes, all read off real cards:
 *
 *  - `KANNADA 125 110` — the maximum, then the marks (Karnataka SSLC);
 *  - `184 ENGLISH LNG & LIT. 070 020 090 NINETY A2` — a subject code first,
 *    then theory, internal assessment and total, then words and a grade (CBSE);
 *  - `KANNADA 800417 APR2022 100 91 91 NINE ONE` — the register number and the
 *    exam month repeated in every row, then the maximum, the marks in figures
 *    and the total (2nd PUC).
 *
 * The marks are the **last** number of the row's run of figures, which is the
 * total on every card seen. A maximum is taken only where the card prints one:
 * the first figure before it that is at least as large. CBSE's second-to-last
 * figure is the internal assessment — 20 — and treating it as a maximum made
 * every CBSE row read as "86 out of 20" and be thrown away.
 */
export function subjectRows(lines: readonly string[]): SubjectRow[] {
  const rows: SubjectRow[] = [];

  lines.forEach((raw, index) => {
    const line = raw.trim();
    if (line === '') return;

    const tokens = line.split(/\s+/);
    let at = 0;
    // A subject code: CBSE's "184", "015".
    if (/^\d{1,4}$/.test(tokens[0]!) && tokens.length > 2 && /[A-Za-z]/.test(tokens[1]!)) at = 1;

    // The subject: words up to the first figure.
    const words: string[] = [];
    while (at < tokens.length && !/^\d/.test(tokens[at]!)) {
      words.push(undamaged(tokens[at]!));
      at += 1;
    }
    const subject = mended(words.join(' ').replace(/[\s.:-]+$/, '').trim());
    if (!/^[A-Za-z][A-Za-z&.,()\-/ ]{1,45}$/.test(subject)) return;
    if (NOT_A_SUBJECT.test(subject) || words.length > 6) return;

    // The figures: marks, skipping a repeated register number or exam month,
    // up to the first word — the marks written out, or a grade.
    const numbers: number[] = [];
    for (; at < tokens.length; at += 1) {
      const token = tokens[at]!;
      if (LONG_NUMBER.test(token) || MONTH_YEAR.test(token)) continue;
      if (!/^\d{1,3}$/.test(token)) break;
      numbers.push(Number(token));
    }
    if (numbers.length === 0) return;

    const obtained = numbers[numbers.length - 1]!;
    const max = numbers.slice(0, -1).find((n) => n >= obtained) ?? null;
    // A lone figure is still a mark; a row whose "marks" exceed any sensible
    // maximum is not a marks row at all.
    if (obtained > 200) return;

    rows.push({ subject, max, obtained, line: index, evidence: line });
  });

  return rows;
}

/** "APRIL 2023", "2022", "MAR-2019" — the year, whatever surrounds it. */
function yearIn(text: string): string | null {
  const match = /\b(19|20)\d{2}\b/.exec(text);
  return match ? match[0] : null;
}

export function extractEducation(ctx: Ctx): void {
  const slot = ctx.hint.documentKey;
  const block = slot === undefined ? undefined : BLOCK_FOR_SLOT[slot];
  if (block === undefined) return;

  const key = (segment: string): FieldKey | null => {
    const candidate = `${block}${segment}`;
    return isFieldKey(candidate) ? candidate : null;
  };

  const put = (
    segment: string,
    found: { value: string; line: number; evidence: string } | null,
    confidence: number,
  ): void => {
    const target = key(segment);
    if (target === null || found === null) return;
    ctx.push({
      key: target,
      value: found.value,
      confidence,
      evidence: found.evidence,
      line: found.line,
      // Nothing on a marks card carries a checksum: every value here is read,
      // not proved, and the user checks it against the card.
      verified: false,
    });
  };

  put('board_or_university', labelledValue(ctx, BOARD_LABEL, looksLikeInstitution), 0.8);
  put('institution', labelledValue(ctx, SCHOOL_LABEL, looksLikeInstitution), 0.8);

  // Read, and on purpose not offered. Said out loud so the omission is not
  // mistaken for a misread by somebody holding the card.
  if (ctx.lines.some((line) => SCHOOL_ADDRESS_LINE.test(line.trim()))) {
    ctx.note(
      'The school’s address printed on this card is not saved as your own address. ' +
        'Your address is read from your Aadhaar card instead.',
    );
  }
  put('registration_number', labelledValue(ctx, REGISTER_LABEL, looksLikeNumber), 0.85);
  put('roll_number', labelledValue(ctx, ROLL_LABEL, looksLikeNumber), 0.85);
  put('percentage', labelledValue(ctx, PERCENTAGE_LABEL, (v) => /^\d{1,3}(\.\d{1,2})?$/.test(v.trim())), 0.8);
  put('result_status', labelledValue(ctx, RESULT_LABEL, (v) => RESULT_WORDS.test(v.trim())), 0.85);

  /*
   * The board's own name is usually the first line of the card rather than a
   * labelled value: "KARNATAKA SECONDARY EDUCATION EXAMINATION BOARD".
   */
  if (!ctx.candidatesHave(key('board_or_university') ?? 'identity.full_name')) {
    const index = ctx.lines.findIndex((line) => /\b(board|university|council)\b/i.test(line));
    const line = ctx.lines[index]?.trim();
    if (line !== undefined && looksLikeInstitution(line) && !/^(?:board|university)\s*[:-]/i.test(line)) {
      put('board_or_university', { value: line, line: index, evidence: line }, 0.7);
    }
  }

  // The year: a labelled one first, then the examination line that names it.
  const labelledYear = labelledValue(ctx, YEAR_LABEL, (v) => yearIn(v) !== null);
  if (labelledYear !== null) {
    put('year_of_passing', { ...labelledYear, value: yearIn(labelledYear.value)! }, 0.8);
  } else {
    const index = ctx.lines.findIndex((line) => /examination|exam\b/i.test(line) && yearIn(line));
    const line = ctx.lines[index];
    if (line !== undefined) {
      put('year_of_passing', { value: yearIn(line)!, line: index, evidence: line.trim() }, 0.65);
    }
  }

  // ---- the table ----------------------------------------------------------
  const rows = subjectRows(ctx.lines);
  if (rows.length >= 2) {
    put(
      'subjects',
      {
        value: rows.map((row) => row.subject).join(', '),
        line: rows[0]!.line,
        evidence: rows[0]!.evidence,
      },
      0.7,
    );

    /*
     * Each subject's own marks, where the vault has a box for that subject at
     * this level — which it has for school subjects and not for a degree's.
     * One language box: the first language row fills it, and a second language
     * is said aloud rather than dropped in silence.
     */
    const unboxed: string[] = [];
    const filled = new Set<string>();
    for (const row of rows) {
      const subject = subjectOf(row.subject);
      const target = subject === null ? null : key(`marks_${subject}`);
      if (target === null || filled.has(target)) {
        unboxed.push(row.subject);
        continue;
      }
      filled.add(target);
      put(
        `marks_${subject}`,
        { value: String(row.obtained), line: row.line, evidence: row.evidence },
        0.7,
      );
    }

    if (filled.size === 0) {
      ctx.note(
        `The ${rows.length} subject names are saved as one list. The vault has no box for each ` +
          'subject’s own marks at this level, so what is saved from the table is the total and ' +
          'the percentage.',
      );
    } else if (unboxed.length > 0) {
      ctx.note(
        `Read, and saved only in the subject list: ${unboxed.join(', ')}. The vault has no box ` +
          `of ${unboxed.length === 1 ? 'its' : 'their'} own for the marks.`,
      );
    }
  }

  /*
   * The totals.
   *
   * A printed "TOTAL 625 565" is the card's own arithmetic and is preferred.
   * Failing that, the subject marks are added up — five numbers read off five
   * rows, which is not a guess, but it scores lower because a misread row
   * changes the answer.
   */
  const totalLine = ctx.lines.findIndex((line) => /^(?:total|grand total|aggregate)\b/i.test(line.trim()));
  const totals = totalLine === -1 ? null : ctx.lines[totalLine]!.match(/\d{1,4}/g);

  if (totals !== null && totals.length >= 1) {
    // The last figure is the total. The maximum, where printed, is the first
    // figure larger than it: "Total Marks : 600 509 509" prints the maximum,
    // the marks in figures and the total, and the second-to-last is not a
    // maximum at all.
    const obtained = totals[totals.length - 1]!;
    const max = totals.slice(0, -1).find((n) => Number(n) > Number(obtained)) ?? null;
    const evidence = ctx.lines[totalLine]!.trim();
    put('marks_obtained', { value: obtained, line: totalLine, evidence }, 0.85);
    if (max !== null) put('max_marks', { value: max, line: totalLine, evidence }, 0.85);
  } else if (rows.length >= 3) {
    const obtained = rows.reduce((sum, row) => sum + row.obtained, 0);
    const max = rows.every((row) => row.max !== null)
      ? rows.reduce((sum, row) => sum + (row.max ?? 0), 0)
      : null;
    put(
      'marks_obtained',
      { value: String(obtained), line: rows[0]!.line, evidence: `added up from ${rows.length} subjects` },
      0.6,
    );
    if (max !== null) {
      put(
        'max_marks',
        { value: String(max), line: rows[0]!.line, evidence: `added up from ${rows.length} subjects` },
        0.6,
      );
    }
  }
}
