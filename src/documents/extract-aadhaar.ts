/**
 * The e-Aadhaar letter (§ reading a document).
 *
 * Not the little card: the A4 letter UIDAI issues as a PDF, which is what a
 * portal asks to be uploaded and what sits in this vault. It is the single
 * richest document a student holds — an addressed block of labelled lines
 * (S/O, VTC, PO, Sub District, District, State, PIN Code, Mobile), the name in
 * two scripts, a date of birth, a gender — and almost none of it was read. The
 * user pressed the button on a page covered in labelled values and got one
 * suggestion back.
 *
 * ## The three numbers, which are not interchangeable
 *
 * - **The Aadhaar number** is printed **masked** on every downloaded letter:
 *   `XXXX XXXX 5521`. It cannot be recovered and must never be guessed at.
 * - **The VID** is sixteen digits. Its first twelve look exactly like an
 *   Aadhaar number in 4-4-4 grouping, which is how a perfectly read VID came
 *   back as "a number … fails its check digit — it has probably been misread",
 *   blaming a photograph that was fine.
 * - **The enrolment number** (`1234/56789/01234`) is neither, and the taxonomy
 *   has no box for it. It is reported as read and not offered, rather than
 *   filed somewhere it does not belong.
 */

import type { FieldKey } from '@/matching/taxonomy';
import { labelledValue, type Ctx } from './extract';

/** The letter's own words, which nothing else prints in this combination. */
const AADHAAR_LETTER =
  /unique identification authority|uidai|\be-?aadhaar\b|enrolment\s*(?:no|number)|\bvid\b/i;

/**
 * Is this the Aadhaar letter?
 *
 * The slot it was filed under, or the letter naming its own issuer. Deliberately
 * strict: these labels — District, State, PIN Code — appear on plenty of other
 * documents, where they belong to a school or an office rather than to the
 * holder, and filing one of those as the applicant's own address puts a wrong
 * address on every form they submit afterwards.
 */
function isAadhaarLetter(ctx: Ctx): boolean {
  if (ctx.hint.documentKey === 'doc.aadhaar_card') return true;
  if (ctx.type === 'aadhaar') return true;
  return AADHAAR_LETTER.test(ctx.joined) && /a[au]dhaar|आधार|ಆಧಾರ್/i.test(ctx.joined);
}

/** The labels UIDAI prints down the left of the address block. */
const LABELS: ReadonlyArray<{ key: FieldKey; label: RegExp; accept: (value: string) => boolean }> = [
  {
    // Village, town or city — UIDAI's own abbreviation.
    key: 'address.permanent.city',
    label: /^(?:vtc|village\s*\/?\s*town\s*\/?\s*city|village|town)\s*[:-]?\s*(.*)$/i,
    accept: isPlaceName,
  },
  {
    // The post office. Not a town of its own; the line under the village.
    key: 'address.permanent.line2',
    label: /^(?:p\.?\s*o\.?|post\s*office|post)\s*[:-]?\s*(.*)$/i,
    accept: isPlaceName,
  },
  {
    // "Sub District" is the taluk, whatever the form later calls it.
    key: 'address.permanent.taluk',
    label: /^(?:sub\s*-?\s*district|taluka?|tehsil|mandal|hobli)\s*[:-]?\s*(.*)$/i,
    accept: isPlaceName,
  },
  {
    /*
     * Spelt as the engine managed it. "District," came back as "Destict," from
     * the user's own letter, with a comma where the colon should be. A label
     * the engine half-read is still a label; what keeps this safe is the value
     * it is allowed to accept — a place name, and nothing else.
     */
    key: 'address.permanent.district',
    label: /^(?:d[ie]s?t[ri]{0,2}c?t|dist)\.?\s*[:,-]?\s*(.*)$/i,
    accept: isPlaceName,
  },
  {
    key: 'address.permanent.state',
    label: /^(?:state)\s*[:-]?\s*(.*)$/i,
    accept: isPlaceName,
  },
  {
    key: 'address.permanent.pincode',
    label: /^(?:pin\s*code|pincode|pin)\s*[:-]?\s*(.*)$/i,
    accept: (value) => /^[1-9][0-9]{5}$/.test(clean(value)),
  },
  {
    key: 'contact.mobile',
    label: /^(?:mobile|mobile\s*(?:no\.?|number)|phone)\s*[:-]?\s*(.*)$/i,
    accept: (value) => /^[6-9][0-9]{9}$/.test(clean(value).replace(/[^0-9]/g, '')),
  },
];

/** Trailing commas are how UIDAI ends every line of the block. */
function clean(value: string): string {
  return value.replace(/[\s,.;]+$/, '').trim();
}

/** A place name: words, no digits, not a whole sentence. */
function isPlaceName(value: string): boolean {
  const trimmed = clean(value);
  return (
    trimmed.length >= 3 &&
    trimmed.length <= 50 &&
    /^[\p{L}\p{M}][\p{L}\p{M}\s'().-]*$/u.test(trimmed) &&
    !/\d/.test(trimmed)
  );
}

/**
 * "S/O", "C/O", "D/O" — the name of the person's father or guardian.
 *
 * And the shapes recognition makes of them. On the user's own letter "S/O:"
 * came back as "5/ಲಿ:" — the S read as a 5, the O as a Kannada letter that the
 * bilingual pass then removed, leaving "5/:". Two characters of a three
 * character label survived, and the name beside it was perfectly readable.
 */
const GUARDIAN_LABEL =
  /^(?:[sc5]\s*[/|]\s*[o0]?|[dw]\s*[/|]\s*[o0]|son\s+of|daughter\s+of)\s*[:,-]\s*(.*)$/i;

/** A person's name: two or three words of letters. */
function isPersonName(value: string): boolean {
  const trimmed = clean(value);
  return (
    trimmed.length >= 3 &&
    trimmed.length <= 60 &&
    /^[\p{L}\p{M}][\p{L}\p{M}\s.'-]*$/u.test(trimmed) &&
    trimmed.split(/\s+/).length <= 5
  );
}

const ENROLMENT = /enrol?ment\s*(?:no\.?|number)?\s*[:-]?\s*(\d{4}\/\d{5}\/\d{5})/i;
const MASKED = /(?:^|\s)[X*]{4}\s*[X*]{4}\s*(\d{4})(?!\d)/im;

export function extractAadhaarLetter(ctx: Ctx): void {
  if (!isAadhaarLetter(ctx)) return;

  for (const entry of LABELS) {
    if (ctx.candidatesHave(entry.key)) continue;
    const found = labelledValue(ctx, entry.label, entry.accept);
    if (found === null) continue;

    ctx.push({
      key: entry.key,
      value:
        entry.key === 'contact.mobile'
          ? clean(found.value).replace(/[^0-9]/g, '')
          : clean(found.value),
      // Labelled, on the one document that carries the holder's own address.
      // Read, not proved: nothing here carries a checksum.
      confidence: 0.85,
      evidence: found.evidence,
      line: found.line,
      verified: false,
    });
  }

  /*
   * The holder's name, from the address label: the letter is addressed "To"
   * its holder, and the Latin spelling of the name is the first line after it
   * that reads as one (the Kannada spelling above it has already been set
   * aside as a script the reader does not read).
   */
  const addressedTo = ctx.lines.findIndex((line) => /^to$/i.test(line.trim()));
  if (addressedTo !== -1) {
    for (const [offset, line] of ctx.lines.slice(addressedTo + 1, addressedTo + 4).entries()) {
      const candidate = line.trim();
      if (!isPersonName(candidate) || !/^[A-Za-z]/.test(candidate)) continue;
      ctx.push({
        key: 'identity.full_name',
        value: clean(candidate),
        confidence: 0.8,
        evidence: `To / ${candidate}`,
        line: addressedTo + 1 + offset,
        verified: false,
      });
      break;
    }
  }

  if (!ctx.candidatesHave('family.father_name')) {
    const guardian = labelledValue(ctx, GUARDIAN_LABEL, isPersonName);
    if (guardian !== null) {
      ctx.push({
        key: 'family.father_name',
        value: clean(guardian.value),
        confidence: 0.8,
        evidence: guardian.evidence,
        line: guardian.line,
        verified: false,
      });
    }
  }

  // ---- the numbers that are not the Aadhaar number -----------------------

  const masked = MASKED.exec(ctx.joined);
  if (masked !== null) {
    ctx.warn(
      `The Aadhaar number on this letter is masked — it shows only the last four digits ` +
        `(${masked[1]}). Every downloaded e-Aadhaar is printed that way, so there is nothing ` +
        'to read: type the number in yourself.',
    );
  }

  if (ENROLMENT.test(ctx.joined)) {
    ctx.note(
      'The enrolment number on this letter was read and not saved: the vault has no box for ' +
        'it, and it is not the Aadhaar number.',
    );
  }

  if (/\bvid\b/i.test(ctx.joined)) {
    ctx.note(
      'The VID is a temporary number that replaces the Aadhaar number on a form. It changes, ' +
        'so it is not saved.',
    );
  }
}
