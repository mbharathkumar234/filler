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

import { INDIAN_STATES } from '@/matching/deterministic';
import { labelledValue, type Ctx } from './extract';

const BANK_SLOTS: ReadonlySet<string> = new Set([
  'doc.bank_passbook',
  'doc.scholarship_application',
]);

/** A bank's own name, printed as the heading of the page. */
const BANK_NAME_LINE = /^((?:[A-Z][A-Za-z&.'-]*\s+){0,5}(?:BANK|Bank)(?:\s+OF\s+[A-Z][A-Za-z]+)?)\s*$/;

// Not "Branch Name & Address": that is the heading of a box, which on the
// user's own passbook was empty, and "& Address" was offered as the branch.
const BRANCH_LABEL = /^(?:branch(?:\s*name)?|branch\s*office)(?!\s*(?:&|and)\s*ad\w{0,2}ress)\s*[:-]?\s*(.*)$/i;
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

/**
 * The holder's block, as a passbook prints it: "NAME AND ADDRESS OF THE ACCOUNT
 * HOLDER/S:", then the holder's name, whose son or daughter they are, and their
 * address down to the PIN. The reader made "ADORESS" of it on the user's own.
 */
const HOLDER_BLOCK =
  /^(?:name\s*(?:and|&)\s*ad\w{0,2}ress\s*of\s*(?:the\s*)?(?:a\/?c|account)\s*holder|(?:a\/?c|account)\s*holder'?s?\s*name\s*(?:and|&)\s*ad\w{0,2}ress)/i;

/** "1.ARJUN MEHTA", "1) ARJUN MEHTA": the first of an account's holders, numbered. */
const NUMBERED = /^\s*\d\s*[.)]\s*/;

/** "S/O R RAMAPPA," under a holder's name — the O read as a nought, or the S as a 5. */
const SON_OR_DAUGHTER = /^(?:[s5d])\s*[/|]\s*[o0]\s*[:.,-]?\s*(.+?)[\s,.;]*$/i;

/** Where the holder's block stops: the passbook's next labelled detail. */
const BLOCK_END =
  /^(?:customer|cust\b|cif\b|operational|mode\s+of|nominat|joint|date\s+of|a\/c|account|ifs|micr|branch|phone|tel\b|mobile|e-?mail|pan\b|sc\s*cod)/i;

const PIN = /(?<!\d)([1-9]\d{5})(?!\d)/;

/** Title case for a town or state, so "TUMAKURU" reads as a form expects it. */
function titleCase(value: string): string {
  return value.toLowerCase().replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
}

/** A person's name as a passbook prints it: words of letters, initials among them. */
function isPersonName(value: string): boolean {
  const trimmed = value.trim();
  return /^[A-Za-z][A-Za-z .'-]{1,58}[A-Za-z.]$/.test(trimmed) && trimmed.split(/\s+/).length <= 6;
}

/**
 * The holder's name, their father's from "S/O", and their own address.
 *
 * The address is read from this block only — never from the "Branch Name &
 * Address" box, which is the bank's, and filing a branch's address as the
 * applicant's would put it on every form they submit.
 */
function readHolderBlock(ctx: Ctx): void {
  const start = ctx.lines.findIndex((line) => HOLDER_BLOCK.test(line.trim()));
  if (start === -1) return;

  const block: Array<{ text: string; index: number }> = [];
  for (let index = start + 1; index < ctx.lines.length && block.length < 6; index += 1) {
    const text = ctx.lines[index]!.trim();
    if (text === '' || BLOCK_END.test(text)) break;
    block.push({ text, index });
  }
  const [first, ...rest] = block;
  if (first === undefined) return;

  const name = first.text.replace(NUMBERED, '').trim();
  if (isPersonName(name)) {
    ctx.push({
      key: 'bank.account_holder',
      value: name,
      confidence: 0.85,
      evidence: first.text,
      line: first.index,
      verified: false,
    });
  }

  const address: Array<{ text: string; index: number }> = [];
  let pin: { value: string; town: string; index: number; text: string } | null = null;
  for (const entry of rest) {
    const relation = SON_OR_DAUGHTER.exec(entry.text);
    if (relation !== null && address.length === 0) {
      if (isPersonName(relation[1]!) && !ctx.candidatesHave('family.father_name')) {
        ctx.push({
          key: 'family.father_name',
          value: relation[1]!.trim(),
          confidence: 0.75,
          evidence: entry.text,
          line: entry.index,
          verified: false,
        });
      }
      continue;
    }
    const found = PIN.exec(entry.text);
    if (found !== null) {
      // "TUMAKURU 572101 INDIA": the town before the PIN, the country after it.
      const town = entry.text.slice(0, found.index).replace(/[\s,-]+$/, '').trim();
      pin = { value: found[1]!, town: /^[A-Za-z][A-Za-z .]+$/.test(town) ? town : '', index: entry.index, text: entry.text };
      break;
    }
    address.push(entry);
  }

  const street = address
    .map((entry) => entry.text.replace(/[\s,]+$/, ''))
    .filter((text) => /[A-Za-z]{3}/.test(text))
    .join(', ');
  if (street.length >= 3) {
    ctx.push({
      key: 'address.permanent.line1',
      value: street,
      confidence: 0.75,
      evidence: address.map((entry) => entry.text).join(' / '),
      line: address[0]!.index,
      verified: false,
    });
  }
  if (pin === null) return;
  if (pin.town !== '' && !INDIAN_STATES.some((state) => state.toLowerCase() === pin.town.toLowerCase())) {
    ctx.push({
      key: 'address.permanent.city',
      value: titleCase(pin.town),
      confidence: 0.7,
      evidence: pin.text,
      line: pin.index,
      verified: false,
    });
  }
  ctx.push({
    key: 'address.permanent.pincode',
    value: pin.value,
    confidence: 0.8,
    evidence: pin.text,
    line: pin.index,
    verified: false,
  });
}

/** "MICR CODE:572052123": nine digits, beside the IFSC on a passbook and under a cheque. */
const MICR = /\bmicr\s*(?:code|no\.?|number)?\s*[:.-]?\s*(\d{9})(?!\d)/i;

/**
 * What says a code on a line is the IFSC: its label, whole or as the reader
 * left it ("IFSC Code", "IFS Code", "SC COd") — or the MICR code a passbook
 * prints beside it, which survives when the label is tidied away as a fragment.
 */
const IFSC_NAMED = /\b(?:ifsc?|fsc|sc\s*cod\w*|micr)\b/i;
/** Four letters and a nought, then a character too few or too many: an IFSC misread by one. */
const IFSC_LIKE = /\b([A-Z]{4}[0O][A-Z0-9]{4,7})\b/g;

/**
 * An IFSC read a character short or long, beside its label.
 *
 * On the user's own passbook an IFSC with four noughts in a row came back a
 * nought short, its label as "SC COd:" — the photo too small to tell the noughts
 * apart. Not an IFSC, so not offered; kept, for RBI's list to say which code it
 * can be.
 */
function nearMissIfsc(ctx: Ctx): void {
  if (ctx.candidatesHave('bank.ifsc')) return;
  ctx.lines.forEach((line, index) => {
    if (!IFSC_NAMED.test(line)) return;
    for (const match of line.matchAll(IFSC_LIKE)) {
      const read = `${match[1]!.slice(0, 4)}0${match[1]!.slice(5)}`;
      if (read.length === 11) continue;
      ctx.nearMiss({ key: 'bank.ifsc', read, line: index, evidence: line.trim() });
    }
  });
}

export function extractBankDetails(ctx: Ctx): void {
  if (!looksLikeBankDocument(ctx)) return;

  readHolderBlock(ctx);
  nearMissIfsc(ctx);

  const micr = ctx.lines.findIndex((line) => MICR.test(line));
  if (micr !== -1) {
    ctx.push({
      key: 'bank.micr',
      value: MICR.exec(ctx.lines[micr]!)![1]!,
      confidence: 0.85,
      evidence: ctx.lines[micr]!.trim(),
      line: micr,
      verified: false,
    });
  }

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
