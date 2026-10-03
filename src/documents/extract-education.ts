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
 *
 * **A table, where the reader found one.** A semester grade card's courses are
 * a table (`table.ts`), and its rows start with a course code and wrap long
 * titles onto a second line — which the line rules below read as no course at
 * all. Read cell by cell, the columns say which figure is the total and which
 * cell is the grade, so the card also gives how many courses are not cleared.
 */

import type { FieldKey, MarkSubject } from '@/matching/taxonomy';
import { isFieldKey } from '@/matching/taxonomy';
import { labelledValue, type Ctx } from './extract';
import type { ReadTable } from './table';

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

/**
 * The words that make a label a number's, not an institution's: VTU prints
 * "University Seat Number", which once filed "Seat Number 1SA21CS042" as the
 * student's university.
 */
const NUMBER_LABEL_WORDS = /\b(?:seat|register|registration|reg|roll|enrol(?:l?ment)?)\s*(?:no\b|number\b)|\busn\b/i;

/** Labels, in the words the boards actually print. */
const BOARD_LABEL =
  /^(?:board\s*\/\s*university|name of (?:the )?board|examining\s+authority|(?:board|university)(?!\s*(?:seat|register|registration|reg|roll|enrol|code|no\b|number)))\s*[:-]?\s*(.*)$/i;
/*
 * "College", but never "College Code No." — a 2nd PUC certificate prints both,
 * and the code was once filed as the institution's name.
 */
const SCHOOL_LABEL =
  /^(?:school|school\s*name|name of (?:the )?(?:school|institution|college)|institution|college(?!\s*code))\s*[:-]?\s*(.*)$/i;
// VTU's "University Seat Number" — the USN — is the number a student is
// registered under for the whole degree, not one exam's seat.
const REGISTER_LABEL =
  /^(?:register(?:ed)?\s*(?:no\.?|number)|registration\s*(?:no\.?|number)|reg\.?\s*no\.?|university\s*seat\s*(?:no\.?|number)|usn)\s*[:-]?\s*(.*)$/i;
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

/*
 * A grade point, after its label — "SGPA 8.45", or "SGPA : 8.45 CGPA : 8.21"
 * when a card prints both on one line. Out of ten; nothing else is.
 */
const SGPA = /(?<![a-z])(?:sgpa|s\.\s*g\.\s*p\.\s*a\.?|semester grade point average)\s*[:=-]?\s*(\d{1,2}(?:\.\d{1,2})?)(?![\d.])/i;
const CGPA =
  /(?<![a-z])(?:cgpa|c\.\s*g\.\s*p\.\s*a\.?|cumulative grade point average)\s*[:=-]?\s*(\d{1,2}(?:\.\d{1,2})?)(?![\d.])/i;
const GRADE_POINT_LABEL = { sgpa: /^(?:sgpa|s\.\s*g\.\s*p\.\s*a\.?)\s*[:=-]?\s*$/i, cgpa: /^(?:cgpa|c\.\s*g\.\s*p\.\s*a\.?)\s*[:=-]?\s*$/i };

function isGradePoint(value: string): boolean {
  return /^\d{1,2}(?:\.\d{1,2})?$/.test(value) && Number(value) <= 10;
}

/** A grade point and the line it was read on: beside its label, or under it. */
function gradePoint(ctx: Ctx, which: 'sgpa' | 'cgpa'): { value: string; line: number; evidence: string } | null {
  const inline = which === 'sgpa' ? SGPA : CGPA;
  for (const [index, raw] of ctx.lines.entries()) {
    const value = inline.exec(raw)?.[1];
    if (value !== undefined && isGradePoint(value)) return { value, line: index, evidence: raw.trim() };
  }
  for (const [index, raw] of ctx.lines.entries()) {
    if (!GRADE_POINT_LABEL[which].test(raw.trim())) continue;
    const value = (ctx.lines[index + 1] ?? '').trim();
    if (isGradePoint(value)) return { value, line: index + 1, evidence: raw.trim() };
  }
  return null;
}

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

// ---- a table of courses ----------------------------------------------------

/** A course read off a table: its name, its marks and whether it was cleared. */
interface Course {
  title: string;
  obtained: number | null;
  max: number | null;
  /** Read from the Result column, or else the Grade column; null when neither says. */
  cleared: boolean | null;
}

/** What a header cell says, less its punctuation: "Max. Marks" → "max marks". */
function headWords(cell: string): string {
  return cell.toLowerCase().replace(/[.:*()]/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * The columns a marks table prints, by the words over them.
 *
 * "Course Code" is not the title — only "Course", "Course Title", "Subject
 * Name" and their kin are. "Grade Points" is a number, not the grade.
 */
const HEAD = {
  title:
    /^(?:(?:course|subject|paper)s?(?: (?:title|name))?|title|name of (?:the )?(?:course|subject|paper)|sub name)$/,
  total:
    /^(?:total(?: marks)?(?: obtained| secured)?|marks (?:obtained|secured|awarded)|obtained(?: marks)?|secured|marks)$/,
  max: /^(?:max(?:imum)?(?: marks)?|full marks|out of)$/,
  grade: /^(?:grade|letter grade|grade (?:awarded|obtained|secured))$/,
  result: /^(?:result|status|result status|p ?\/ ?f)$/,
} as const;

/** Rows under the courses that are not courses: the totals and the grade points. */
const NOT_A_COURSE =
  /^(?:total|grand total|aggregate|sgpa|cgpa|gpa|result|percentage|credits?(?: earned| registered)?|semester grade)\b/i;

/*
 * A course's outcome in the words universities print. A grade of "A" is a
 * good grade, while a result of "A" is Absent — so the two columns have their
 * own words. RA is Anna University's re-appear, U its "reappearance", NE "not
 * eligible".
 */
const FAILED_GRADE = /^(?:f|fail(?:ed)?|ab|abs|absent|ra|u|re-?appear|ne)$/i;
const PASSED_GRADE = /^(?:o|s|[a-e][+]{0,2}|[a-e][12]|p|pp|pass(?:ed)?)$/i;
const FAILED_RESULT = /^(?:f|fail(?:ed)?|a|ab|abs|absent|ra|u|ne|x)$/i;
const PASSED_RESULT = /^(?:p|pass(?:ed)?|q|qualified)$/i;

function clearedBy(cell: string | undefined, failed: RegExp, passed: RegExp): boolean | null {
  const word = (cell ?? '').trim();
  if (failed.test(word)) return false;
  if (passed.test(word)) return true;
  return null;
}

/** A mark in a cell: a whole number of up to three figures, and nothing else. */
function markIn(cell: string | undefined): number | null {
  const value = (cell ?? '').trim();
  return /^\d{1,3}$/.test(value) ? Number(value) : null;
}

/**
 * The courses in a table, when it is a table of courses.
 *
 * Its header — in the first three rows, under any heading rows above it —
 * must name a title column and one of a marks, grade or result column. A row
 * with only a title in it is the tail of the title above, wrapped onto a row of
 * its own. A row with marks and no title is a course the reader lost, and the
 * table is then refused: a list missing one course would add up to the wrong
 * total and count the wrong backlogs, and the lines are read instead.
 */
export function coursesIn(table: ReadTable): Course[] | null {
  for (let at = 0; at < Math.min(3, table.rows.length); at += 1) {
    const header = table.rows[at]!.map(headWords);
    const column = (pattern: RegExp): number | null => {
      const index = header.findIndex((cell) => pattern.test(cell));
      return index === -1 ? null : index;
    };
    const title = column(HEAD.title);
    const total = column(HEAD.total);
    const grade = column(HEAD.grade);
    const result = column(HEAD.result);
    const max = column(HEAD.max);
    if (title === null || (total === null && grade === null && result === null)) continue;

    const courses: Course[] = [];
    for (const row of table.rows.slice(at + 1)) {
      const name = (row[title] ?? '').trim().replace(/\s+/g, ' ');
      const filled = row.filter((cell, index) => index !== title && cell.trim() !== '').length;
      if (name === '') {
        if (filled >= 2) return null;
        continue;
      }
      if (NOT_A_COURSE.test(name)) continue;
      const last = courses[courses.length - 1];
      if (filled === 0 && last !== undefined) {
        last.title = `${last.title} ${name}`;
        continue;
      }
      courses.push({
        title: name,
        obtained: total === null ? null : markIn(row[total]),
        max: max === null ? null : markIn(row[max]),
        cleared:
          (result === null ? null : clearedBy(row[result], FAILED_RESULT, PASSED_RESULT)) ??
          (grade === null ? null : clearedBy(row[grade], FAILED_GRADE, PASSED_GRADE)),
      });
    }
    return courses.length >= 2 ? courses : null;
  }
  return null;
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
    // The first line that is a heading, not the first with the word in it:
    // "University Seat Number 1SA21CS042" names a university and is a number.
    const index = ctx.lines.findIndex((raw) => {
      const line = raw.trim();
      return (
        /\b(board|university|council)\b/i.test(line) &&
        looksLikeInstitution(line) &&
        !/^(?:board|university)\s*[:-]/i.test(line) &&
        !NUMBER_LABEL_WORDS.test(line)
      );
    });
    const line = ctx.lines[index]?.trim();
    if (line !== undefined) put('board_or_university', { value: line, line: index, evidence: line }, 0.7);
  }

  // What a grade card adds up to: this semester's, and every semester's so far.
  put('sgpa', gradePoint(ctx, 'sgpa'), 0.85);
  put('cgpa', gradePoint(ctx, 'cgpa'), 0.85);

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
  /*
   * A table the reader found comes first: its columns are known. The lines are
   * the fallback, and the only reading a PDF's text layer has.
   */
  const courses = ctx.tables.map(coursesIn).find((found) => found !== null) ?? null;
  const rows: Array<Omit<SubjectRow, 'obtained'> & { obtained: number | null }> =
    courses === null
      ? subjectRows(ctx.lines)
      : courses.map((course) => {
          const line = lineNaming(ctx, course.title);
          return {
            subject: course.title,
            max: course.max,
            obtained: course.obtained,
            line,
            evidence: ctx.lines[line]?.trim() || course.title,
          };
        });
  if (rows.length >= 2) {
    // Separated by what the names do not hold: "Transform Calculus, Fourier
    // Series and Numerical Techniques" is one course, and a comma would make it three.
    const separator = rows.some((row) => row.subject.includes(',')) ? '; ' : ', ';
    put(
      'subjects',
      {
        value: rows.map((row) => row.subject).join(separator),
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
      if (target === null || filled.has(target) || row.obtained === null) {
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
  } else if (rows.length >= 3 && rows.every((row) => row.obtained !== null)) {
    const obtained = rows.reduce((sum, row) => sum + (row.obtained ?? 0), 0);
    const max = rows.every((row) => row.max !== null)
      ? rows.reduce((sum, row) => sum + (row.max ?? 0), 0)
      : null;
    put(
      'marks_obtained',
      {
        value: String(obtained),
        line: rows[0]!.line,
        evidence: `added up from ${rows.length} ${courses === null ? 'subjects' : 'courses, the table’s Total column'}`,
      },
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

  /*
   * Backlogs: the courses on this card not cleared. Only when every course's
   * grade or result was read — one cell the reader could not make out would
   * make the count a guess, and a form asking "Number of backlogs" is not a
   * place to guess.
   */
  if (courses !== null && courses.every((course) => course.cleared !== null)) {
    const failed = courses.filter((course) => course.cleared === false).length;
    const line = lineNaming(ctx, courses[0]!.title);
    put(
      'backlogs',
      {
        value: String(failed),
        line,
        evidence: `${failed} of ${courses.length} courses on this card not cleared, by its Grade or Result column`,
      },
      0.7,
    );
  }
}

/**
 * The line a table cell's text was read on, for the picture of where it came
 * from: the first holding its first three words. A wrapped title is on two
 * lines, and the first is where it starts. -1, and no picture, when none does.
 */
function lineNaming(ctx: Ctx, text: string): number {
  const start = text.split(' ').slice(0, 3).join(' ').toLowerCase();
  return ctx.lines.findIndex((line) => line.toLowerCase().includes(start));
}
