/**
 * Reading the certificates a claim rests on (§ reading a document).
 *
 * A Karnataka Nadakacheri certificate carries an **RD number** — the
 * acknowledgement a portal asks for in a text box beside the upload, and the
 * one value on the document nobody can recite from memory. Every kind carries
 * one and they are not interchangeable: a caste certificate's number in the
 * income certificate's box is a rejected application, so the number is filed
 * by the kind of certificate it came from and by nothing else.
 *
 * The kind is read from the slot the document was filed under, and failing
 * that from what the certificate calls itself in its own heading. When neither
 * says, the number is left alone: there is no safe box for it.
 */

import type { FieldKey } from '@/matching/taxonomy';
import { labelledValue, type Ctx } from './extract';
import { amountInWords } from './number-words';

type Kind = 'caste' | 'income' | 'domicile' | 'article371j';

/** Which slot holds which kind. */
const KIND_FOR_SLOT: Readonly<Record<string, Kind>> = {
  'doc.caste_certificate': 'caste',
  'doc.caste_certificate_form_d': 'caste',
  'doc.obc_certificate': 'caste',
  'doc.ews_certificate': 'income',
  'doc.income_certificate': 'income',
  'doc.domicile_certificate': 'domicile',
  'doc.article_371j_certificate': 'article371j',
};

/** What a certificate calls itself, when nobody has said. */
const KIND_IN_TEXT: ReadonlyArray<{ kind: Kind; pattern: RegExp }> = [
  // 371(J) first: its certificate is also an eligibility certificate and
  // mentions a region, and the more specific name has to win.
  { kind: 'article371j', pattern: /371\s*\(?\s*j\s*\)?|kalyana\s+karnataka|hyderabad[- ]karnataka/i },
  { kind: 'caste', pattern: /\bcaste\b|\bcommunity certificate\b|scheduled (?:caste|tribe)|\bobc\b/i },
  { kind: 'income', pattern: /\bincome certificate\b|annual income|economically weaker/i },
  { kind: 'domicile', pattern: /\bdomicile\b|\bnativity\b|permanent resident/i },
];

/** The box each kind's number belongs in. */
const NUMBER_KEY: Readonly<Record<Kind, FieldKey | null>> = {
  caste: 'eligibility.caste_certificate_number',
  income: 'eligibility.income_certificate_number',
  article371j: 'eligibility.article_371j_number',
  // A domicile certificate has a number, and the taxonomy has no box for it.
  // Saying so is better than putting it in somebody else's.
  domicile: null,
};

const RD_LABEL =
  /^(?:r\.?\s*d\.?\s*(?:no\.?|number)|acknowledgement\s*(?:no\.?|number)|certificate\s*(?:no\.?|number)|application\s*(?:no\.?|number))\s*[:-]?\s*(.*)$/i;

/** An RD number: letters and digits, no spaces, long enough to be one. */
function looksLikeRdNumber(value: string): boolean {
  return /^[A-Z]{0,4}[0-9][0-9A-Z/-]{5,29}$/i.test(value.trim());
}

/** The categories a portal offers, from the words a certificate uses. */
const CATEGORY_WORDS: ReadonlyArray<{ value: string; pattern: RegExp }> = [
  { value: 'ST', pattern: /scheduled\s+tribe/i },
  { value: 'SC', pattern: /scheduled\s+caste/i },
  { value: 'OBC', pattern: /other\s+backward|backward\s+class/i },
  { value: 'EWS', pattern: /economically\s+weaker/i },
];

const COMMUNITY_LINE = /belongs?\s+to(?:\s+the)?\s+([A-Z][A-Za-z ()'-]{2,40}?)\s+(?:community|caste|tribe)\b/i;
/*
 * An amount, and not an identifier.
 *
 * The lookarounds are the whole rule: without them "RD9876543210987" read as
 * an income of nine trillion rupees, because the digits inside a certificate
 * number are digits too. An amount stands on its own — after "Rs.", a rupee
 * sign, or the word income — with no letter or digit glued to it.
 */
const INCOME_LINE =
  /(?:income|\bRs\.?|₹)[^0-9A-Za-z]{0,20}(?<![A-Za-z0-9])([0-9][0-9,]{3,12})(?![A-Za-z0-9])/i;
/** "annual income from all sources is 45000": the Nadakacheri certificate's wording. */
const INCOME_SENTENCE =
  /annual\s+income\b[^0-9\n]{0,60}?\bis\s+(?:rs\.?\s*)?(?<![A-Za-z0-9])([0-9][0-9,]{3,12})(?![A-Za-z0-9])/i;
/** "Rs. forty five thousand only": an amount in words, after the rupee mark. */
const RUPEES_IN_WORDS = /(?:\bRs\.?|\brupees\b|₹)\s*([A-Za-z][A-Za-z ]{3,80})/i;
const STATE_LINE = /(?:permanent\s+)?resident\s+of\s+(?:the\s+)?([A-Z][A-Za-z ]{3,30}?)\s+state\b/i;

export function extractClaims(ctx: Ctx): void {
  const slot = ctx.hint.documentKey;
  const kind: Kind | undefined =
    (slot === undefined ? undefined : KIND_FOR_SLOT[slot]) ??
    KIND_IN_TEXT.find((entry) => entry.pattern.test(ctx.joined))?.kind;

  // ---- the RD number ------------------------------------------------------
  // Nadakacheri prints the number twice on one line — once plainly, once in
  // asterisks for its barcode — so the value is the first of them.
  const firstOf = (value: string) => value.trim().split(/\s+/)[0]!.replace(/^\*+|\*+$/g, '');
  const labelled = labelledValue(ctx, RD_LABEL, (value) => looksLikeRdNumber(firstOf(value)));
  const rd = labelled === null ? null : { ...labelled, value: firstOf(labelled.value) };
  if (rd !== null && kind !== undefined) {
    const key = NUMBER_KEY[kind];
    if (key !== null) {
      ctx.push({
        key,
        value: rd.value,
        confidence: 0.85,
        evidence: rd.evidence,
        line: rd.line,
        verified: false,
      });
    }
  }

  if (kind === 'caste') {
    const community = COMMUNITY_LINE.exec(ctx.joined);
    if (community) {
      const line = ctx.lines.findIndex((text) => COMMUNITY_LINE.test(text));
      ctx.push({
        key: 'eligibility.caste',
        value: community[1]!.trim(),
        confidence: 0.75,
        evidence: (ctx.lines[line] ?? community[0]).trim(),
        line: Math.max(line, 0),
        verified: false,
      });
    }

    const category = CATEGORY_WORDS.find((entry) => entry.pattern.test(ctx.joined));
    if (category) {
      const line = ctx.lines.findIndex((text) => category.pattern.test(text));
      ctx.push({
        key: 'identity.category',
        value: category.value,
        confidence: 0.8,
        evidence: (ctx.lines[line] ?? '').trim(),
        line: Math.max(line, 0),
        verified: false,
      });
    }
  }

  if (kind === 'income') {
    // The certificate's own sentence first — "Their family annual income from
    // all sources is 45000 ( Rs. forty five thousand only.)" — where words stand
    // between "income" and the figure; then the figure after "Rs." or "income".
    const pattern = INCOME_SENTENCE.test(ctx.joined) ? INCOME_SENTENCE : INCOME_LINE;
    const amount = pattern.exec(ctx.joined);
    const figure = amount ? amount[1]!.replace(/,/g, '') : null;

    // The same amount, written out: "( Rs. forty five thousand only.)". Recognised
    // independently of the figure, so it is a second way to the number — and
    // on the user's own certificate, the only one that came through.
    const wordsLine = ctx.lines.findIndex((text) => RUPEES_IN_WORDS.test(text));
    const inWords =
      wordsLine === -1
        ? null
        : amountInWords(
            // The sentence may wrap; the words run on into the next line.
            `${RUPEES_IN_WORDS.exec(ctx.lines[wordsLine]!)![1]!} ${ctx.lines[wordsLine + 1] ?? ''}`,
          );

    if (figure !== null) {
      const line = ctx.lines.findIndex((text) => pattern.test(text));
      ctx.push({
        key: 'family.annual_income',
        // "1,20,000" is lakh grouping; a form wants the digits.
        value: figure,
        confidence: 0.75,
        evidence: (ctx.lines[line] ?? '').trim(),
        line: Math.max(line, 0),
        verified: false,
      });
      if (inWords !== null && String(inWords) !== figure) {
        ctx.warn(
          `The income on this certificate reads ${figure} in figures and ${inWords} in words. ` +
            'One of the two was misread — check it against the certificate before saving.',
        );
      }
    } else if (inWords !== null) {
      ctx.push({
        key: 'family.annual_income',
        value: String(inWords),
        // From the words alone, with no figure to agree with them.
        confidence: 0.6,
        evidence: ctx.lines[wordsLine]!.trim(),
        line: wordsLine,
        verified: false,
      });
    }
  }

  if (kind === 'domicile') {
    const state = STATE_LINE.exec(ctx.joined);
    if (state) {
      const line = ctx.lines.findIndex((text) => STATE_LINE.test(text));
      ctx.push({
        key: 'eligibility.domicile_state',
        value: state[1]!.trim(),
        confidence: 0.75,
        evidence: (ctx.lines[line] ?? '').trim(),
        line: Math.max(line, 0),
        verified: false,
      });
    }
  }

  if (kind === 'article371j') {
    const line = ctx.lines.findIndex((text) => /371|kalyana|hyderabad[- ]karnataka/i.test(text));
    ctx.push({
      key: 'eligibility.article_371j',
      // The certificate exists; that *is* the claim.
      value: 'Yes',
      confidence: 0.8,
      evidence: (ctx.lines[line] ?? '').trim(),
      line: Math.max(line, 0),
      verified: false,
    });
  }
}
