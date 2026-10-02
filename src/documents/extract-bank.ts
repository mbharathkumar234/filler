/**
 * A bank passbook, and a driving licence (§ reading a document).
 *
 * The passbook's two numbers already had shapes to check them against — an
 * account number's label, an IFSC's fixed `0` in position five — and were read
 * long before this. What was left is the part a scholarship form asks for in
 * words: the bank, the branch, and the name the account is held in.
 *
 * The account holder is stored separately from the applicant's own name because
 * they are occasionally different people, and a scholarship paid into the wrong
 * name takes a term to undo. Read it, show it, let the user see both.
 */

import { labelledValue, type Ctx } from './extract';

const BANK_SLOTS: ReadonlySet<string> = new Set([
  'doc.bank_passbook',
  'doc.scholarship_application',
]);

/** A bank's own name, printed as the heading of the page. */
const BANK_NAME_LINE = /^((?:[A-Z][A-Za-z&.'-]*\s+){0,5}(?:BANK|Bank)(?:\s+OF\s+[A-Z][A-Za-z]+)?)\s*$/;

const BRANCH_LABEL = /^(?:branch(?:\s*name)?|branch\s*office)\s*[:-]?\s*(.*)$/i;
const HOLDER_LABEL =
  /^(?:(?:name\s+of\s+)?(?:the\s+)?account\s*holder(?:'s)?(?:\s*name)?|customer\s*name|holder\s*name)\s*[:-]?\s*(.*)$/i;
const TYPE_LABEL = /^(?:account\s*type|type\s*of\s*account|a\/c\s*type)\s*[:-]?\s*(.*)$/i;

/** The account kinds a form offers, in the words it offers them in. */
const ACCOUNT_TYPES: ReadonlyArray<{ value: string; pattern: RegExp }> = [
  { value: 'Savings', pattern: /saving/i },
  { value: 'Current', pattern: /current/i },
  { value: 'Salary', pattern: /salary/i },
];

/** A branch or a holder: words, not a number. */
function looksLikeWords(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length >= 3 && trimmed.length <= 60 && /[A-Za-z]{3}/.test(trimmed) && !/^\d+$/.test(trimmed);
}

/**
 * Is this a bank's document?
 *
 * The slot, or the page itself carrying both a bank's name and one of the two
 * things only a bank prints. A marks card that happens to mention a bank in a
 * fee line is not a passbook.
 */
function looksLikeBankDocument(ctx: Ctx): boolean {
  const slot = ctx.hint.documentKey;
  if (slot !== undefined && BANK_SLOTS.has(slot)) return true;
  if (ctx.type === 'bank_passbook') return true;
  return /\bifs[c]?\s*(?:code)?\b/i.test(ctx.joined) && /\bbank\b/i.test(ctx.joined);
}

export function extractBankDetails(ctx: Ctx): void {
  if (!looksLikeBankDocument(ctx)) return;

  const heading = ctx.lines.findIndex((line) => BANK_NAME_LINE.test(line.trim()));
  if (heading !== -1) {
    ctx.push({
      key: 'bank.bank_name',
      value: BANK_NAME_LINE.exec(ctx.lines[heading]!.trim())![1]!.trim(),
      confidence: 0.75,
      evidence: ctx.lines[heading]!.trim(),
      line: heading,
      verified: false,
    });
  }

  const branch = labelledValue(ctx, BRANCH_LABEL, looksLikeWords);
  if (branch !== null) {
    ctx.push({
      key: 'bank.branch',
      value: branch.value,
      confidence: 0.8,
      evidence: branch.evidence,
      line: branch.line,
      verified: false,
    });
  }

  const holder = labelledValue(ctx, HOLDER_LABEL, looksLikeWords);
  if (holder !== null) {
    ctx.push({
      key: 'bank.account_holder',
      value: holder.value,
      confidence: 0.8,
      evidence: holder.evidence,
      line: holder.line,
      verified: false,
    });
  }

  /*
   * The account number on a cheque, which carries no label at all.
   *
   * A cancelled cheque is what a scholarship form asks for, and it prints the
   * number on its own line above the MICR band. Read strictly by labels it
   * yields nothing — so on a bank's own document a bare run of nine to eighteen
   * digits is offered, at a confidence that says plainly that nothing on the
   * page confirmed what it is. The MICR band itself (a nine-digit code beside a
   * six-digit cheque number) is not it, so a line with three numbers on it is
   * left alone.
   */
  if (!ctx.candidatesHave('bank.account_number')) {
    const index = ctx.lines.findIndex((line) => {
      const trimmed = line.trim();
      return /^\d{9,18}$/.test(trimmed);
    });
    if (index !== -1) {
      ctx.push({
        key: 'bank.account_number',
        value: ctx.lines[index]!.trim(),
        confidence: 0.6,
        evidence: ctx.lines[index]!.trim(),
        line: index,
        verified: false,
      });
    }
  }

  const type = labelledValue(ctx, TYPE_LABEL, looksLikeWords);
  if (type !== null) {
    const known = ACCOUNT_TYPES.find((entry) => entry.pattern.test(type.value));
    if (known !== undefined) {
      ctx.push({
        key: 'bank.account_type',
        value: known.value,
        confidence: 0.8,
        evidence: type.evidence,
        line: type.line,
        verified: false,
      });
    }
  }
}

/*
 * A driving licence number.
 *
 * "KA05 20200001234": a state code, an RTO number, the year of issue and a
 * serial, printed with a space or a hyphen in whichever places the state feels
 * like. The shape alone is not enough to go on — a register number could wear
 * it — so this is label-anchored, and the spaces come out because a portal's box
 * rejects them.
 */
const LICENCE_LABEL =
  /^(?:dl\s*(?:no\.?|number)?|d\.?l\.?\s*no\.?|driving\s*licence\s*(?:no\.?|number)?|licence\s*(?:no\.?|number))\s*[:-]?\s*(.*)$/i;

const LICENCE_SHAPE = /^[A-Z]{2}[- ]?\d{2}[- ]?(?:19|20)?\d{2}[- ]?\d{6,8}$/i;

export function extractDrivingLicence(ctx: Ctx): void {
  const found = labelledValue(ctx, LICENCE_LABEL, (value) => LICENCE_SHAPE.test(value.trim()));
  if (found === null) return;

  ctx.push({
    key: 'id.driving_licence',
    value: found.value.replace(/[- ]/g, '').toUpperCase(),
    confidence: 0.8,
    evidence: found.evidence,
    line: found.line,
    // A licence number carries no check digit that is published. Read, not proved.
    verified: false,
  });
}
