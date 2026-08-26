/**
 * Scripts, languages, and digits (§ document extraction).
 *
 * ## Why this file is about scripts and not languages
 *
 * The feature was asked for as "English or any of the 22 important languages of
 * India". OCR does not read languages; it reads scripts. The two do not line up:
 *
 *  - **Devanagari alone carries eight** of the twenty-two — Hindi, Marathi,
 *    Konkani, Maithili, Bodo, Dogri, Sanskrit and Nepali. One model reads all
 *    of them.
 *  - **Kashmiri is written in two scripts** depending on who is writing it.
 *  - **Three have no usable trained data at all**: Santali (Ol Chiki),
 *    Manipuri (Meitei Mayek), and Kashmiri in its Perso-Arabic orthography,
 *    which is not the same thing as the Urdu model however similar it looks.
 *
 * So the table below is deliberately a *coverage* table rather than a list of
 * supported languages. A feature that silently returns nothing for Santali and
 * leaves the user blaming their photo is worse than one that says, before they
 * upload anything, that it cannot read Santali.
 *
 * ## Digits
 *
 * This is the part that decides whether the feature works on a Hindi card or
 * only an English one. An Aadhaar number on a Hindi card is printed in
 * Devanagari digits; the Verhoeff checksum, the length check and the stored
 * value all need ASCII. Everything downstream assumes `normaliseDigits` has
 * already run.
 */

export type IndicScript =
  | 'Latin'
  | 'Devanagari'
  | 'Bengali'
  | 'Gurmukhi'
  | 'Gujarati'
  | 'Odia'
  | 'Tamil'
  | 'Telugu'
  | 'Kannada'
  | 'Malayalam'
  | 'Arabic'
  | 'OlChiki'
  | 'MeiteiMayek';

/** How well we can actually read a language's script. */
export type Coverage =
  /** A trained model exists and is good on printed cards. */
  | 'good'
  /** Readable only because it shares a script with something better supported. */
  | 'shared'
  /** No usable model. Say so; do not pretend. */
  | 'none';

interface ScriptInfo {
  /** Unicode ranges, as a test-friendly regex source. */
  pattern: RegExp;
  /** The digit zero in this script, when it has its own. */
  zero?: number;
  /** The Tesseract model name, when one exists. */
  model?: string;
}

export const INDIC_SCRIPTS: Readonly<Record<IndicScript, ScriptInfo>> = {
  Latin: { pattern: /[A-Za-z]/, model: 'eng' },
  Devanagari: { pattern: /[ऀ-ॿ]/, zero: 0x0966, model: 'hin' },
  Bengali: { pattern: /[ঀ-৿]/, zero: 0x09e6, model: 'ben' },
  Gurmukhi: { pattern: /[਀-੿]/, zero: 0x0a66, model: 'pan' },
  Gujarati: { pattern: /[઀-૿]/, zero: 0x0ae6, model: 'guj' },
  Odia: { pattern: /[଀-୿]/, zero: 0x0b66, model: 'ori' },
  Tamil: { pattern: /[஀-௿]/, zero: 0x0be6, model: 'tam' },
  Telugu: { pattern: /[ఀ-౿]/, zero: 0x0c66, model: 'tel' },
  Kannada: { pattern: /[ಀ-೿]/, zero: 0x0ce6, model: 'kan' },
  Malayalam: { pattern: /[ഀ-ൿ]/, zero: 0x0d66, model: 'mal' },
  Arabic: { pattern: /[؀-ۿ]/, zero: 0x0660, model: 'urd' },
  // No model. Present so the table can name the script it cannot read.
  OlChiki: { pattern: /[᱐-᱿]/ },
  MeiteiMayek: { pattern: /[ꯀ-꯿]/ },
};

export interface ScheduledLanguage {
  name: string;
  /** Endonym, for showing the user their own language in their own script. */
  endonym: string;
  scripts: IndicScript[];
  coverage: Coverage;
  /** Why, when the answer is not obvious. Shown in the UI for 'shared'/'none'. */
  note?: string;
}

/**
 * The twenty-two languages of the Eighth Schedule, with an honest verdict each.
 *
 * `shared` is not a lesser tier by accident: a Konkani card read with the Hindi
 * Devanagari model will get the digits and the shapes right and may stumble on
 * vocabulary. For extracting an ID number that is enough, and for extracting a
 * name it is worth flagging, which is what the note is for.
 */
export const SCHEDULED_LANGUAGES: readonly ScheduledLanguage[] = [
  { name: 'Assamese', endonym: 'অসমীয়া', scripts: ['Bengali'], coverage: 'good' },
  { name: 'Bengali', endonym: 'বাংলা', scripts: ['Bengali'], coverage: 'good' },
  {
    name: 'Bodo',
    endonym: 'बड़ो',
    scripts: ['Devanagari'],
    coverage: 'shared',
    note: 'Read with the Devanagari model. Numbers and dates are reliable; names may need correcting.',
  },
  {
    name: 'Dogri',
    endonym: 'डोगरी',
    scripts: ['Devanagari'],
    coverage: 'shared',
    note: 'Read with the Devanagari model.',
  },
  { name: 'Gujarati', endonym: 'ગુજરાતી', scripts: ['Gujarati'], coverage: 'good' },
  { name: 'Hindi', endonym: 'हिन्दी', scripts: ['Devanagari'], coverage: 'good' },
  { name: 'Kannada', endonym: 'ಕನ್ನಡ', scripts: ['Kannada'], coverage: 'good' },
  {
    name: 'Kashmiri',
    endonym: 'کٲشُر',
    scripts: ['Arabic', 'Devanagari'],
    coverage: 'none',
    note: 'Kashmiri’s Perso-Arabic orthography is not the Urdu model, and there is no trained model for it. Type these details in by hand.',
  },
  {
    name: 'Konkani',
    endonym: 'कोंकणी',
    scripts: ['Devanagari'],
    coverage: 'shared',
    note: 'Read with the Devanagari model.',
  },
  {
    name: 'Maithili',
    endonym: 'मैथिली',
    scripts: ['Devanagari'],
    coverage: 'shared',
    note: 'Read with the Devanagari model.',
  },
  { name: 'Malayalam', endonym: 'മലയാളം', scripts: ['Malayalam'], coverage: 'good' },
  {
    name: 'Manipuri',
    endonym: 'ꯃꯤꯇꯩꯂꯣꯟ',
    scripts: ['MeiteiMayek', 'Bengali'],
    coverage: 'none',
    note: 'There is no trained model for Meitei Mayek. A card printed in the older Bengali script may read; one in Meitei Mayek will not.',
  },
  { name: 'Marathi', endonym: 'मराठी', scripts: ['Devanagari'], coverage: 'good' },
  {
    name: 'Nepali',
    endonym: 'नेपाली',
    scripts: ['Devanagari'],
    coverage: 'good',
  },
  { name: 'Odia', endonym: 'ଓଡ଼ିଆ', scripts: ['Odia'], coverage: 'good' },
  { name: 'Punjabi', endonym: 'ਪੰਜਾਬੀ', scripts: ['Gurmukhi'], coverage: 'good' },
  {
    name: 'Sanskrit',
    endonym: 'संस्कृतम्',
    scripts: ['Devanagari'],
    coverage: 'shared',
    note: 'Read with the Devanagari model.',
  },
  {
    name: 'Santali',
    endonym: 'ᱥᱟᱱᱛᱟᱲᱤ',
    scripts: ['OlChiki'],
    coverage: 'none',
    note: 'There is no trained model for Ol Chiki. Type these details in by hand.',
  },
  {
    name: 'Sindhi',
    endonym: 'سنڌي',
    scripts: ['Arabic', 'Devanagari'],
    coverage: 'shared',
    note: 'Read with the Urdu model, which is close but not exact.',
  },
  { name: 'Tamil', endonym: 'தமிழ்', scripts: ['Tamil'], coverage: 'good' },
  { name: 'Telugu', endonym: 'తెలుగు', scripts: ['Telugu'], coverage: 'good' },
  { name: 'Urdu', endonym: 'اردو', scripts: ['Arabic'], coverage: 'good' },
];

export function scriptsForLanguage(name: string): IndicScript[] {
  return SCHEDULED_LANGUAGES.find((l) => l.name === name)?.scripts ?? [];
}

export function coverageOf(name: string): Coverage {
  return SCHEDULED_LANGUAGES.find((l) => l.name === name)?.coverage ?? 'none';
}

/** Every script that has a model we can actually load. */
export function readableScripts(): IndicScript[] {
  return (Object.keys(INDIC_SCRIPTS) as IndicScript[]).filter(
    (script) => INDIC_SCRIPTS[script].model !== undefined,
  );
}

// ---------------------------------------------------------------------------
// Digits
// ---------------------------------------------------------------------------

/** Script zero code points, built once from the table above. */
const DIGIT_BASES: readonly number[] = Object.values(INDIC_SCRIPTS)
  .map((info) => info.zero)
  .filter((zero): zero is number => zero !== undefined);

/**
 * Rewrite every Indic digit as its ASCII equivalent, leaving everything else
 * exactly as it was.
 *
 * Character by character rather than by regex range, because the ranges are not
 * contiguous across scripts and a single expression covering all of them is
 * unreadable and easy to get subtly wrong.
 */
export function normaliseDigits(text: string): string {
  if (text === '') return '';

  let out = '';
  for (const char of text) {
    const code = char.codePointAt(0);
    if (code === undefined) {
      out += char;
      continue;
    }

    let converted = false;
    for (const base of DIGIT_BASES) {
      if (code >= base && code <= base + 9) {
        out += String(code - base);
        converted = true;
        break;
      }
    }
    if (!converted) out += char;
  }
  return out;
}

/**
 * Below this share of a document's letters, a script is noise.
 *
 * OCR misreads a glyph here and there. One stray Devanagari character in a page
 * of English must not flip the whole document to Hindi and trigger a re-run
 * with the wrong model — that turns a good result into a bad one.
 */
const SCRIPT_FLOOR = 0.02;

/** Which scripts is this text actually written in? */
export function detectScripts(text: string): IndicScript[] {
  const counts = new Map<IndicScript, number>();
  let letters = 0;

  for (const char of text) {
    for (const [name, info] of Object.entries(INDIC_SCRIPTS) as Array<[IndicScript, ScriptInfo]>) {
      if (info.pattern.test(char)) {
        counts.set(name, (counts.get(name) ?? 0) + 1);
        letters += 1;
        break;
      }
    }
  }

  if (letters === 0) return [];

  return [...counts.entries()]
    .filter(([, count]) => count / letters >= SCRIPT_FLOOR)
    .sort((a, b) => b[1] - a[1])
    .map(([name]) => name);
}
