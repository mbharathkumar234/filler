/**
 * Reading fields out of a scanned document (§ document extraction).
 *
 * ## What this is, and what it is deliberately not
 *
 * This takes text — already read off an image by `ocr.ts`, or pasted, or pulled
 * from a text-layer PDF — and proposes values the user might want to save. It
 * is pure: no image, no worker, no vault. That keeps the interesting half
 * testable without a browser, which is what `CLAUDE.md` asks for in this
 * directory, and it means the hard part can be exercised against a hundred
 * awkward strings rather than a handful of photographs.
 *
 * **Nothing here writes to the vault.** Every result is a *candidate* the user
 * confirms. That is not politeness; it is the central safety property.
 *
 * ## The hazard
 *
 * The danger in this feature is not failing to read a number. It is reading one
 * that is almost right. A misread digit in an Aadhaar number, accepted into the
 * vault, then filled at high confidence into forty applications, is exactly the
 * failure mode the rest of this product is built to prevent — and unlike a bad
 * match on a form, nothing downstream would ever notice.
 *
 * So the design leans on structure wherever the format offers any:
 *
 *  - **Aadhaar carries a Verhoeff check digit.** It catches every single-digit
 *    error, which is precisely what OCR produces. A twelve-digit run that fails
 *    it is not offered at all — it is reported as a probable misread, which is
 *    a far more useful thing to tell somebody than nothing.
 *  - **PAN has a fixed shape** including a holder-type letter in position four.
 *    Its final check character uses an unpublished algorithm, so PAN is
 *    format-checked and explicitly **not** marked verified. Claiming a
 *    verification we cannot perform would be worse than claiming none.
 *  - **IFSC always has a `0` in position five.** The `0`/`O` confusion there is
 *    the classic passbook misread and makes the code useless.
 *
 * Only a checksum earns a pre-ticked box on the suggestion screen. Everything
 * else the user ticks themselves.
 */

import type { FieldKey } from '@/matching/taxonomy';
import { detectScripts, normaliseDigits, type IndicScript } from './indic';
import { latinise, trimNoise } from './bilingual';
import { extractEducation } from './extract-education';
import { extractClaims } from './extract-claims';
import { extractAddress } from './extract-address';
import { extractAadhaarLetter } from './extract-aadhaar';
import { extractCertifiedPerson } from './extract-certify';
import { extractEntrance } from './extract-entrance';
import { extractBankDetails, extractDrivingLicence } from './extract-bank';

export type DocumentType =
  | 'aadhaar'
  | 'pan'
  | 'voter_id'
  | 'passport'
  | 'driving_licence'
  | 'bank_passbook'
  | 'unknown';

export interface Candidate {
  key: FieldKey;
  /** Normalised and ready to store — ASCII digits, ISO dates. */
  value: string;
  confidence: number;
  /** The line it came from, quoted, so the user can check it against the card. */
  evidence: string;
  /** Index into the document's lines, for highlighting. */
  line: number;
  /** A checksum or structural rule confirmed this. Only these are pre-ticked. */
  verified: boolean;
  /** Always false here. The user confirms; this module never does. */
  confirmed: false;
  /** Should the suggestion screen tick this by default? */
  suggestChecked: boolean;
}

export interface ExtractionResult {
  documentType: DocumentType;
  candidates: Candidate[];
  scripts: IndicScript[];
  /** Things worth telling the user that are not candidates — e.g. a misread. */
  warnings: string[];
  /** Things read and deliberately not offered, so the omission is not silent. */
  notes: string[];
}

// ---------------------------------------------------------------------------
// Checksums and shapes
// ---------------------------------------------------------------------------

/** Dihedral group D5 multiplication table. */
const VERHOEFF_D: readonly (readonly number[])[] = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
  [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
  [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
  [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
  [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
  [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
  [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
  [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
];

/** Permutation table, applied by position. */
const VERHOEFF_P: readonly (readonly number[])[] = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
  [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
  [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
  [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
];

/**
 * The Aadhaar check digit.
 *
 * Verhoeff rather than a modulus sum because that is what UIDAI uses, and
 * because its guarantee is the one that matters here: **every single-digit
 * error is caught**, and almost every transposition of adjacent digits. Those
 * are the two things OCR gets wrong.
 */
export function isValidAadhaar(digits: string): boolean {
  if (!/^\d{12}$/.test(digits)) return false;
  // UIDAI does not issue numbers beginning 0 or 1.
  if (digits[0] === '0' || digits[0] === '1') return false;

  let check = 0;
  const reversed = [...digits].reverse();
  for (let i = 0; i < reversed.length; i += 1) {
    const digit = Number(reversed[i]);
    check = VERHOEFF_D[check]![VERHOEFF_P[i % 8]![digit]!]!;
  }
  return check === 0;
}

/**
 * The fourth character of a PAN says what kind of holder it is.
 *
 * A PAN with something else there was misread — very often an `H` seen as an
 * `X`, or a `K` as an `R`. Checking it turns a shape test into a slightly
 * sharper one, which is all PAN allows: the final character is a check digit
 * whose algorithm is not published, so nothing here can verify a PAN outright.
 */
const PAN_HOLDER_TYPES = new Set([
  'A', 'B', 'C', 'F', 'G', 'H', 'J', 'L', 'P', 'T',
]);

export function isWellFormedPan(value: string): boolean {
  if (!/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(value)) return false;
  return PAN_HOLDER_TYPES.has(value[3]!);
}

/** IFSC: four letters, a literal zero, then six of either. */
export function isWellFormedIfsc(value: string): boolean {
  return /^[A-Z]{4}0[A-Z0-9]{6}$/.test(value);
}

// ---------------------------------------------------------------------------
// Document identification
// ---------------------------------------------------------------------------

const TYPE_MARKERS: ReadonlyArray<{ type: DocumentType; pattern: RegExp }> = [
  { type: 'pan', pattern: /income\s*tax|permanent\s+account\s+number|आयकर/i },
  { type: 'aadhaar', pattern: /a[au]dhaar|आधार|unique\s+identification/i },
  { type: 'voter_id', pattern: /election\s+commission|elector|मतदाता/i },
  { type: 'passport', pattern: /passport|पासपोर्ट/i },
  { type: 'driving_licence', pattern: /driving\s+licen[cs]e|transport\s+department/i },
  { type: 'bank_passbook', pattern: /passbook|ifsc|account\s+number|शाखा/i },
];

function identify(text: string): DocumentType {
  for (const { type, pattern } of TYPE_MARKERS) {
    if (pattern.test(text)) return type;
  }
  return 'unknown';
}

// ---------------------------------------------------------------------------
// Line-level helpers
// ---------------------------------------------------------------------------

/** Lines a card prints that are never a person's name. */
const BOILERPLATE =
  /government of india|भारत सरकार|income tax|आयकर|unique identification|आधार|election commission|republic of india|passport|permanent account number|identity card|govt\.? of india|department|आम आदमी/i;

// "Candidate Name", "Student Name" — what a marks card calls the person it is
// about, and what an application form calls them too.
const NAME_LABEL =
  /^(?:name|नाम|पूरा नाम|full name|candidate'?s?\s*name|student'?s?\s*name|name of (?:the )?(?:candidate|student)|நபர்|பெயர்)\s*[:-]?\s*(.*)$/i;
// "Father Name" with no apostrophe is how most cards print it.
const FATHER_LABEL =
  /^(?:father'?s?\s*(?:\/\s*guardian'?s?\s*)?name|name of (?:the )?father|पिता का नाम|पिता)\s*[:-]?\s*(.*)$/i;
const MOTHER_LABEL =
  /^(?:mother'?s?\s*name|name of (?:the )?mother|माता का नाम|माता)\s*[:-]?\s*(.*)$/i;
const DOB_LABEL = /\b(?:dob|date\s+of\s+birth|birth)\b|जन्म|பிறந்த/i;

/** Looks like a person's name rather than a caption or a number. */
function looksLikeName(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length < 3 || trimmed.length > 60) return false;
  if (/\d/.test(trimmed)) return false;
  if (BOILERPLATE.test(trimmed)) return false;
  const words = trimmed.split(/\s+/);
  return words.length >= 1 && words.length <= 5;
}

function isLatin(text: string): boolean {
  return /[A-Za-z]/.test(text);
}

// ---------------------------------------------------------------------------
// The extractors
// ---------------------------------------------------------------------------

/**
 * What the vault knows about this document, which the text cannot say.
 *
 * A marks card does not reliably print whose marks card it is — "S.S.L.C." is
 * a Karnataka word, "CLASS X" a CBSE one, and a semester card says neither.
 * The user filed it under a slot, so the slot is the answer: without it the
 * education rules stay silent rather than file Class 10 marks under Class 12.
 */
export interface ExtractionHint {
  /** The `doc.*` slot this document is saved in. */
  documentKey?: FieldKey;
}

export interface Ctx {
  lines: string[];
  joined: string;
  type: DocumentType;
  /** The slot the document is filed under, when the caller knows it. */
  hint: ExtractionHint;
  push: (c: Omit<Candidate, 'confirmed' | 'suggestChecked'>) => void;
  warn: (message: string) => void;
  /**
   * Something read and deliberately not offered.
   *
   * Distinct from `warn`, which means *something may be wrong*. A note means
   * *nothing is wrong and here is what I did not save*: the school's address on
   * a marks card, the marks of each separate subject. Without it the screen
   * silently omits things the user can see on the card in their hand, and
   * silence there reads as a misread.
   */
  note: (message: string) => void;
  /** Has an earlier extractor already claimed this key? */
  candidatesHave: (key: FieldKey) => boolean;
}

function extractAadhaar(ctx: Ctx): void {
  const hasContext = /a[au]dhaar|आधार|unique identification/i.test(ctx.joined);

  ctx.lines.forEach((line, index) => {
    /*
     * A VID is not an Aadhaar number.
     *
     * "VID : 4417 0290 6831 5502" is sixteen digits in four groups, and its
     * first twelve are a 4-4-4 run followed by a *space* — so the "not part of
     * a longer run" guard below never noticed, the checksum failed on a number
     * that had been read perfectly, and the user was told their photograph was
     * bad. The VID is printed on every downloaded e-Aadhaar, so this is the
     * common case, not an edge one.
     */
    if (/\bvid\b/i.test(line)) return;

    // 12 digits, optionally grouped 4-4-4, and not part of a longer run —
    // including a fourth group of four, which makes it a VID.
    for (const match of line.matchAll(
      /(?<![\d])(\d{4})[ -]?(\d{4})[ -]?(\d{4})(?![ -]?\d)/g,
    )) {
      const digits = `${match[1]}${match[2]}${match[3]}`;

      if (isValidAadhaar(digits)) {
        ctx.push({
          key: 'id.aadhaar',
          value: digits,
          // Without a card's own wording around it, a valid twelve-digit run is
          // still only a guess. It stays below the threshold that pre-ticks.
          confidence: hasContext ? 0.95 : 0.75,
          evidence: line.trim(),
          line: index,
          verified: true,
        });
        continue;
      }

      // Worth reporting only when it really looks like a misread Aadhaar
      // rather than some other twelve-digit thing.
      if (hasContext && digits[0] !== '0' && digits[0] !== '1') {
        ctx.warn(
          `A number on this document looks like an Aadhaar number but fails its check digit — it has probably been misread. Retake the photo, or type it in yourself.`,
        );
      }
    }
  });
}

function extractPan(ctx: Ctx): void {
  const hasContext = /income\s*tax|permanent\s+account|आयकर|\bpan\b/i.test(ctx.joined);

  ctx.lines.forEach((line, index) => {
    for (const match of line.matchAll(/\b([A-Z]{5}[0-9]{4}[A-Z])\b/g)) {
      const value = match[1]!;
      if (!isWellFormedPan(value)) continue;
      ctx.push({
        key: 'id.pan',
        value,
        confidence: hasContext ? 0.85 : 0.7,
        evidence: line.trim(),
        line: index,
        // PAN's check character algorithm is not published. Never claim it.
        verified: false,
      });
    }
  });
}

function extractVoterAndPassport(ctx: Ctx): void {
  ctx.lines.forEach((line, index) => {
    for (const match of line.matchAll(/\b([A-Z]{3}\d{7})\b/g)) {
      ctx.push({
        key: 'id.voter',
        value: match[1]!,
        confidence: ctx.type === 'voter_id' ? 0.85 : 0.6,
        evidence: line.trim(),
        line: index,
        verified: false,
      });
    }

    for (const match of line.matchAll(/\b([A-PR-WY]\d{7})\b/g)) {
      if (ctx.type !== 'passport') continue;
      ctx.push({
        key: 'id.passport',
        value: match[1]!,
        confidence: 0.85,
        evidence: line.trim(),
        line: index,
        verified: false,
      });
    }
  });
}

function extractBank(ctx: Ctx): void {
  ctx.lines.forEach((line, index) => {
    for (const match of line.matchAll(/\b([A-Z]{4}0[A-Z0-9]{6})\b/g)) {
      if (!isWellFormedIfsc(match[1]!)) continue;
      ctx.push({
        key: 'bank.ifsc',
        value: match[1]!,
        confidence: 0.85,
        evidence: line.trim(),
        line: index,
        verified: false,
      });
    }

    // Account numbers have no shared format, so this is label-anchored only.
    const account = /(?:account\s*(?:no|number)?|a\/c)\s*[:.-]?\s*(\d{9,18})\b/i.exec(line);
    if (account) {
      ctx.push({
        key: 'bank.account_number',
        value: account[1]!,
        confidence: 0.8,
        evidence: line.trim(),
        line: index,
        verified: false,
      });
    }
  });
}

/** Day-first, because that is what Indian documents print. */
function toIsoDate(day: number, month: number, year: number): string | null {
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > 31) return null;
  // A plausible birth year, and never in the future.
  const thisYear = new Date().getUTCFullYear();
  if (year < 1900 || year > thisYear) return null;

  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;

  const pad = (n: number) => String(n).padStart(2, '0');
  return `${year}-${pad(month)}-${pad(day)}`;
}

function extractDob(ctx: Ctx): void {
  ctx.lines.forEach((line, index) => {
    // Label-anchored on purpose: a card prints issue dates and expiry dates
    // too, and taking one of those as a birth date puts a wrong date on every
    // form the user files afterwards.
    if (!DOB_LABEL.test(line)) return;

    const match = /(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})/.exec(line);
    if (!match) return;

    const iso = toIsoDate(Number(match[1]), Number(match[2]), Number(match[3]));
    if (iso === null) return;

    ctx.push({
      key: 'identity.dob',
      value: iso,
      confidence: 0.85,
      evidence: line.trim(),
      line: index,
      verified: false,
    });
  });
}

/**
 * Word boundaries that work outside Latin.
 *
 * `\b` is defined against `[A-Za-z0-9_]`, so `\bमहिला\b` can never match: no
 * Devanagari character is a word character, and so there is no boundary there
 * to find. The first version of this file used `\b` and therefore detected no
 * gender on any non-Latin card — the entire point of the feature — and the test
 * for a Hindi-only card is what caught it.
 *
 * These lookarounds are Unicode-aware and behave identically in every script.
 * Any future pattern matching an Indic word must use `anyOf`, not `\b`.
 */
const EDGE_BEFORE = String.raw`(?<![\p{L}\p{N}])`;
const EDGE_AFTER = String.raw`(?![\p{L}\p{N}])`;

function anyOf(...words: string[]): RegExp {
  return new RegExp(`${EDGE_BEFORE}(?:${words.join('|')})${EDGE_AFTER}`, 'iu');
}

const GENDERS: ReadonlyArray<{ value: string; pattern: RegExp }> = [
  {
    value: 'Female',
    pattern: anyOf('female', 'महिला', 'स्त्री', 'பெண்', 'మహిళ', 'ಮಹಿಳೆ', 'സ്ത്രീ', 'মহিলা', 'સ્ત્રી'),
  },
  {
    value: 'Male',
    pattern: anyOf('male', 'पुरुष', 'ஆண்', 'పురుషుడు', 'ಪುರುಷ', 'പുരുഷൻ', 'পুরুষ', 'પુરુષ'),
  },
  {
    value: 'Transgender',
    pattern: anyOf('transgender', 'ट्रांसजेंडर', 'तृतीय लिंग'),
  },
];

function extractGender(ctx: Ctx): void {
  ctx.lines.forEach((line, index) => {
    for (const { value, pattern } of GENDERS) {
      if (!pattern.test(line)) continue;
      ctx.push({
        key: 'identity.gender',
        value,
        confidence: 0.8,
        evidence: line.trim(),
        line: index,
        verified: false,
      });
      return; // "Female" contains "male"; first match wins, and Female is first.
    }
  });
}

/**
 * A value that follows a label — on the label's own line, or the next one.
 *
 * The shape nearly every Indian document is printed in: "Father's Name :
 * MOHAN KUMAR", or the label on one line with the value under it. The label
 * regex must capture the inline value as group 1.
 *
 * Was private to `extractNames`; a marks card needs the same reading for its
 * board, its school and its register number, and two copies of this would be
 * two sets of edge cases.
 */
export function labelledValue(
  ctx: Ctx,
  label: RegExp,
  accept: (value: string) => boolean,
): { value: string; line: number; evidence: string } | null {
  for (const [index, raw] of ctx.lines.entries()) {
    const line = raw.trim();
    const match = label.exec(line);
    if (!match) continue;

    const inline = (match[1] ?? '').trim();
    const value = inline !== '' ? inline : (ctx.lines[index + 1] ?? '').trim();
    if (!accept(value)) continue;

    return { value, line: inline !== '' ? index : index + 1, evidence: line };
  }
  return null;
}

function extractNames(ctx: Ctx): void {
  const claimed = new Set<number>();

  const labelled = (
    label: RegExp,
    key: FieldKey,
  ): void => {
    ctx.lines.forEach((line, index) => {
      const match = label.exec(line.trim());
      if (!match) return;
      claimed.add(index);

      // The value is either on the label's own line or the one beneath it.
      const inline = (match[1] ?? '').trim();
      const value = inline !== '' ? inline : (ctx.lines[index + 1] ?? '').trim();
      const valueLine = inline !== '' ? index : index + 1;
      if (!looksLikeName(value)) return;
      claimed.add(valueLine);

      ctx.push({
        key,
        value,
        confidence: 0.8,
        evidence: line.trim(),
        line: valueLine,
        verified: false,
      });
    });
  };

  // Parents first: "Father's Name" contains "Name", and a generic pass would
  // otherwise claim the father's name as the applicant's.
  labelled(FATHER_LABEL, 'family.father_name');
  labelled(MOTHER_LABEL, 'family.mother_name');
  labelled(NAME_LABEL, 'identity.full_name');

  if (ctx.candidatesHave('identity.full_name')) return;

  // Unlabelled, which is how an Aadhaar card prints it: the name sits directly
  // above the date of birth, in both scripts. Prefer the Latin spelling —
  // portal forms almost always want that one, and the user can still edit it.
  const anchor = ctx.lines.findIndex((line) => DOB_LABEL.test(line) || GENDERS.some((g) => g.pattern.test(line)));
  if (anchor <= 0) return;

  const above: Array<{ value: string; line: number }> = [];
  for (let i = Math.max(0, anchor - 2); i < anchor; i += 1) {
    const value = (ctx.lines[i] ?? '').trim();
    if (!claimed.has(i) && looksLikeName(value)) above.push({ value, line: i });
  }
  if (above.length === 0) return;

  const chosen = above.find((entry) => isLatin(entry.value)) ?? above[above.length - 1]!;
  ctx.push({
    key: 'identity.full_name',
    value: chosen.value,
    // No label said so; it was inferred from position. Lower, and never ticked.
    confidence: 0.65,
    evidence: chosen.value,
    line: chosen.line,
    verified: false,
  });
}

// ---------------------------------------------------------------------------

/**
 * A zero the engine read as the letter O.
 *
 * Only where the digits around it make that certain: inside a run of digits
 * ("2O22"), or ending a run of two or more with no letter after it — "3000o (",
 * the income on the user's own certificate as it was read. A word is never
 * touched: an O with a letter beside it stays an O.
 */
export function zeroesForOs(text: string): string {
  return text.replace(/(?<=\d)[oO](?=\d)/g, '0').replace(/(?<=\d{2})[oO](?![A-Za-z0-9])/g, '0');
}

/**
 * Read what we can out of a document's text.
 *
 * Every value is normalised on the way in — Indic digits to ASCII, dates to
 * ISO — so the rest of the system never has to know which script the card was
 * printed in.
 */
export function extractFromText(raw: string, hint: ExtractionHint = {}): ExtractionResult {
  const normalised = zeroesForOs(normaliseDigits(raw));
  /*
   * Every rule below reads English. A Karnataka document prints each label
   * twice — once in Kannada, once in English, usually on one line — and an
   * office form prints the label in Kannada alone with the value in English
   * beside it. `latinise` reduces a line to what it says in English, so no rule
   * needs a second alphabet; `trimNoise` drops the fragments a misread leaves at
   * the ends of a line. Neither invents a word: only labels are translated,
   * never values.
   */
  const lines = normalised.split(/\r?\n/).map((line) => trimNoise(latinise(line.trim())));
  const joined = lines.join('\n');

  const candidates: Array<Omit<Candidate, 'confirmed' | 'suggestChecked'>> = [];
  const warnings: string[] = [];
  const notes: string[] = [];

  const ctx: Ctx = {
    lines,
    joined,
    type: identify(joined),
    hint,
    push: (candidate) => {
      // One value per key. The extractors run in rough order of evidence, but
      // order alone is not enough: a guess from position (the line above a date
      // of birth) runs before a name the document certifies in a sentence, and
      // is weaker. So a strictly better-evidenced reading replaces a weaker
      // one; an equal one does not, and the first to speak keeps its place.
      const existing = candidates.findIndex((c) => c.key === candidate.key);
      if (existing === -1) {
        candidates.push(candidate);
      } else if (candidate.confidence > candidates[existing]!.confidence) {
        candidates[existing] = candidate;
      }
    },
    warn: (message) => {
      if (!warnings.includes(message)) warnings.push(message);
    },
    note: (message) => {
      if (!notes.includes(message)) notes.push(message);
    },
    candidatesHave: (key) => candidates.some((c) => c.key === key),
  };

  extractAadhaar(ctx);
  extractPan(ctx);
  extractVoterAndPassport(ctx);
  extractBank(ctx);
  extractDob(ctx);
  extractGender(ctx);
  extractNames(ctx);
  // A name certified in a sentence, where no label named it.
  extractCertifiedPerson(ctx);
  // Last: it reads the qualification blocks, and it wants the names above to
  // have claimed the person first.
  extractAadhaarLetter(ctx);
  extractEducation(ctx);
  extractEntrance(ctx);
  extractClaims(ctx);
  extractBankDetails(ctx);
  extractDrivingLicence(ctx);
  extractAddress(ctx);

  return {
    documentType: ctx.type,
    scripts: detectScripts(raw),
    warnings,
    notes,
    candidates: candidates
      .sort((a, b) => b.confidence - a.confidence)
      .map((candidate) => ({
        ...candidate,
        confirmed: false as const,
        // Only a checksum earns a pre-ticked box. Everything else is the
        // user's decision, made while looking at the card.
        suggestChecked: candidate.verified,
      })),
  };
}
