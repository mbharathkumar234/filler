/**
 * Reading a document that is printed twice (§ reading a document).
 *
 * ## The problem this solves
 *
 * Every document a Karnataka student holds except a CBSE marks card prints each
 * heading in Kannada and again in English, usually on the same line:
 *
 * ```
 * ವಿದ್ಯಾರ್ಥಿಯ ಹೆಸರು / Student Name : PRIYA S
 * ```
 *
 * The rules that fill this vault are anchored to a label at the *start* of a
 * line, so that line matches nothing: it does not begin with "Student". Worse,
 * on an office form the label is often in Kannada alone, with the value in
 * English beside it — the value is perfectly readable and nothing claims it.
 *
 * So each line is reduced to what it says in English: the Latin half where
 * there are two, and a translated label where there is only one. The result is
 * a line the existing rules already understand, which is the point — no rule
 * needs to learn a second alphabet.
 *
 * ## What is deliberately not done
 *
 * Nothing is translated except **labels**. A name, a place, a caste or a school
 * printed only in Kannada stays exactly as it is: a transliteration would be a
 * guess at the spelling the user's own documents use, and the user would then
 * be filing that guess into applications. Labels are a closed set of words that
 * mean one thing; values are not.
 */

/** The Kannada block, and the Devanagari block an Aadhaar card uses. */
const INDIC = /[ऀ-ॿಀ-೿]/;
const INDIC_RUN = /[ऀ-ॿಀ-೿]+(?:\s+[ऀ-ॿಀ-೿]+)*/g;

/**
 * Label words, in the two scripts these documents are printed in.
 *
 * Longest first, because "ತಂದೆಯ ಹೆಸರು" (father's name) must be recognised before
 * "ಹೆಸರು" (name) claims half of it. Everything here is a label — a word that
 * names a box on a form — and never a value.
 */
const LABELS: ReadonlyArray<readonly [RegExp, string]> = [
  // Kannada
  [/ವಿದ್ಯಾರ್ಥಿಯ\s*ಹೆಸರು/g, 'Student Name'],
  [/ತಂದೆಯ\s*ಹೆಸರು/g, 'Father Name'],
  [/ತಾಯಿಯ\s*ಹೆಸರು/g, 'Mother Name'],
  [/ಶಾಲೆಯ\s*ಹೆಸರು/g, 'School Name'],
  [/ಜನ್ಮ\s*ದಿನಾಂಕ/g, 'Date of Birth'],
  [/ಹುಟ್ಟಿದ\s*ದಿನಾಂಕ/g, 'Date of Birth'],
  [/ನೋಂದಣಿ\s*ಸಂಖ್ಯೆ/g, 'Registration Number'],
  [/ನೋಂದಾವಣಿ\s*ಸಂಖ್ಯೆ/g, 'Registration Number'],
  [/ಖಾತೆ\s*ಸಂಖ್ಯೆ/g, 'Account Number'],
  [/ವಾರ್ಷಿಕ\s*ಆದಾಯ/g, 'Annual Income'],
  [/ಒಟ್ಟು\s*ಅಂಕಗಳು/g, 'Total Marks'],
  [/ಫಲಿತಾಂಶ/g, 'Result'],
  [/ವಿಳಾಸ/g, 'Address'],
  [/ಹೆಸರು/g, 'Name'],
  [/ತಂದೆ/g, 'Father'],
  [/ತಾಯಿ/g, 'Mother'],
  [/ಶಾಲೆ/g, 'School'],
  [/ಕಾಲೇಜು/g, 'College'],
  [/ಒಟ್ಟು/g, 'Total'],
  [/ಆದಾಯ/g, 'Income'],
  [/ಜಾತಿ/g, 'Caste'],
  [/ಲಿಂಗ/g, 'Gender'],
  [/ವರ್ಷ/g, 'Year'],
  [/ಶಾಖೆ/g, 'Branch'],

  // Devanagari
  [/जन्म\s*तिथि/g, 'Date of Birth'],
  [/पिता\s*का\s*नाम/g, 'Father Name'],
  [/माता\s*का\s*नाम/g, 'Mother Name'],
  [/नाम/g, 'Name'],
  [/पता/g, 'Address'],
  [/पिता/g, 'Father'],
  [/माता/g, 'Mother'],
  [/लिंग/g, 'Gender'],
  [/वर्ष/g, 'Year'],
];

/**
 * Tidy up what is left once a script has been taken out of a line.
 *
 * Including the label that is now printed twice: a card that says
 * "ಹೆಸರು / Student Name" becomes "Student Name / Student Name" the moment the
 * Kannada is translated, and a rule anchored to the start of a line would then
 * read the second copy as the value.
 */
function tidy(line: string): string {
  return line
    .replace(/\s{2,}/g, ' ')
    .replace(/^[\s/|,:-]+/, '')
    .replace(/[\s/|,-]+$/, '')
    .replace(/^(.{2,40}?)\s*[/|]\s*\1(?!\p{L})/iu, '$1')
    .trim();
}

/**
 * One line, as the rules should see it.
 *
 * Labels are translated. The other script is then dropped **only where English
 * says the same thing** — which is the label, and a value that was printed
 * twice. A value printed *once*, in Kannada or Devanagari alone, is kept exactly
 * as it is: an Aadhaar card whose holder's name appears only in Devanagari has
 * always been read that way, and a card that names itself only in its own script
 * is how the card is recognised at all.
 */
export function latinise(line: string): string {
  if (!INDIC.test(line)) return line;

  /*
   * The commonest shape by far: the card prints its own English beside the
   * Kannada, separated by a slash. Keeping that half is better than translating
   * the other one, because the card's own wording is what the rules were
   * written against — "Register Number", not this module's guess at it.
   *
   * Only the first separator, and only when the left of it is the other script:
   * a date is full of slashes and must survive intact.
   */
  const bilingual = /^([^/|]*[ऀ-ॿಀ-೿][^/|]*)[/|]\s*(.+)$/.exec(line);
  if (bilingual !== null && /[A-Za-z]/.test(bilingual[2]!)) {
    return tidy(bilingual[2]!);
  }

  let out = line;
  for (const [pattern, english] of LABELS) out = out.replace(pattern, english);

  // Split at the label separator: everything before it names a box, everything
  // after it is what somebody wrote in the box.
  const separator = out.search(/[:]/);
  const label = separator === -1 ? '' : out.slice(0, separator + 1);
  const value = separator === -1 ? out : out.slice(separator + 1);

  // A label is a closed set of words that mean one thing, so the English one is
  // always enough.
  const cleanLabel = label.replace(INDIC_RUN, ' ');

  // A value is only dropped when there is something else on that side of the
  // line to read it from — the same value printed in both scripts.
  const hasLatinValue = /[A-Za-z0-9]/.test(value);
  const cleanValue = hasLatinValue ? value.replace(INDIC_RUN, ' ') : value;

  return tidy(`${cleanLabel}${cleanValue}`);
}

/**
 * Short words that are real, so a line never loses them.
 *
 * Every one of these was on a document before it was on this list: "Rs" opens
 * the amount on an income certificate, "DL" the number on a licence, "No" half
 * the labels ever printed. A short word that is not here is judged by its
 * company (below) rather than by its length alone.
 */
const REAL_SHORT =
  /^(?:a|i|in|is|it|of|on|or|to|no|by|at|as|be|do|we|he|the|and|for|not|nil|sl|sr|mr|ms|dr|rs|dl|pu|ug|pg|iti|air|gen|sub|sem|s|w|m|f|x|xi|xii|ii|iii|iv|v|vi|vii|viii|ix|pcm|pcmb|cbse|sslc|puc|kea|cet|pan|dob|ifsc|rd|st|sc|obc|ews|pass|fail|no\.|s\.)$/i;

/** A lone colon or dash: structure, not noise, and it ends a run of noise. */
const SEPARATOR = /^[:;,.\-–—]+$/;

/*
 * The word inside a token, stripped of the punctuation around it.
 *
 * `\p{M}` is not decoration. Every vowel in an Indic script is a combining
 * mark rather than a letter, so a pattern written with `\p{L}` alone reads the
 * middle of "ಹೆಸರು" as punctuation and calls the whole word a misread — which
 * silently deleted every Kannada and Devanagari line on a card.
 */
function wordIn(token: string): string {
  return token.replace(/^[^\p{L}\p{M}\p{N}]+|[^\p{L}\p{M}\p{N}]+$/gu, '');
}

/** From this many letters, a token with a stray mark in it is a word that was damaged. */
const DAMAGED_WORD_LETTERS = 6;

/**
 * Is this token a fragment a misread left behind rather than a word?
 *
 * `shouting` — whether the line is mostly capitals, as a marks card's headings
 * are — is what makes a short lowercase token suspicious. On a line of prose,
 * "is" and "per" are words; on a line reading "DEPARTMENT OF PRE-UNIVERSITY
 * EDUCATION", the lowercase "zn" beside them is what a Kannada letterform looks
 * like to an engine that was only given English.
 */
function isFragment(token: string, shouting: boolean): boolean {
  if (SEPARATOR.test(token)) return false;

  const word = wordIn(token);
  if (word === '') return true;
  if (/\d/.test(word)) return false;
  if (REAL_SHORT.test(word)) return false;

  // Punctuation inside a word: "fe”", "ori)". Long words are left alone — a
  // misread rarely invents one, and a mark inside six letters or more is a
  // damaged word: "MAT!JEMATICS", off a card whose H is broken in print.
  // Apostrophes are part of words — "Father's Name" is a label on half the
  // documents here, and calling it a misread loses the name on the line below.
  if (/[^\p{L}\p{M}\p{N}.\-/'’]/u.test(word)) {
    return (word.match(/\p{L}/gu) ?? []).length < DAMAGED_WORD_LETTERS;
  }

  if (word.length > 3) return false;
  // A case change inside a three-letter token is not how anything is printed.
  if (/\p{Lu}/u.test(word) && /\p{Ll}/u.test(word)) return true;
  return shouting && !/\p{Lu}/u.test(word);
}

/**
 * Weak enough to be swept away *with* neighbouring fragments.
 *
 * A short word at the edge of a line — the "S" of "PRIYA S" — is kept when it
 * stands alone and dropped when it is adrift in a run of fragments, which is the
 * difference between a surname initial and the tail of a misread heading.
 */
function isWeak(token: string, shouting: boolean): boolean {
  if (isFragment(token, shouting)) return true;
  if (SEPARATOR.test(token)) return false;
  const word = wordIn(token);
  return !/\d/.test(word) && word.length <= 3;
}

/** Is this line mostly capitals, the way a card's headings are printed? */
function isShouting(line: string): boolean {
  const letters = line.match(/\p{L}/gu) ?? [];
  if (letters.length === 0) return false;
  const capitals = letters.filter((letter) => /\p{Lu}/u.test(letter)).length;
  return capitals / letters.length >= 0.7;
}

/**
 * Strip the fragments a misread leaves at the ends of a line.
 *
 * Only at the ends, and only fragments: the middle of a line is where the
 * values are, and a rule that eats values to tidy a heading is worse than the
 * untidy heading. A line that is nothing but fragments comes back empty, which
 * is the honest reading of it.
 */
export function trimNoise(line: string): string {
  const tokens = line.split(/\s+/).filter((token) => token !== '');
  if (tokens.length === 0) return '';

  const shouting = isShouting(line);
  const fragment = (token: string) => isFragment(token, shouting);
  const weak = (token: string) => isWeak(token, shouting);

  // The run of weak tokens at each end. It is swept away only if it actually
  // contains a fragment — otherwise the line simply starts with a short word.
  let start = 0;
  while (start < tokens.length && weak(tokens[start]!)) start += 1;
  if (!tokens.slice(0, start).some(fragment)) start = 0;

  let end = tokens.length - 1;
  // A line with a label on it ends in its value, and a value is not ours to
  // tidy: "Name : Om" is two letters that look exactly like a fragment and are
  // somebody's name. Only a line with no label is trimmed from the right.
  if (!/[:]/.test(line)) {
    while (end >= start && weak(tokens[end]!)) end -= 1;
    if (!tokens.slice(end + 1).some(fragment)) end = tokens.length - 1;
  }

  return start > end ? '' : tokens.slice(start, end + 1).join(' ');
}
