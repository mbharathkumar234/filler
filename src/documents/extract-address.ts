/**
 * An address, from the one document that carries the holder's own.
 *
 * Aadhaar prints where the person lives, which is why a portal asks for it.
 * Every other document in the vault prints somebody *else's* address — a
 * school's on a marks card, a Tahsildar's office on a caste certificate, a
 * branch's on a passbook — and filing one of those as the applicant's address
 * would put a wrong address on every form they submit afterwards. So this
 * reads an Aadhaar card and nothing else.
 */

import { INDIAN_STATES } from '@/matching/deterministic';
import type { Ctx } from './extract';

/** The line that opens the block, in the words the card uses. */
const ADDRESS_LABEL = /^(?:address|पता|ಚಿಲಾಸೆ)\s*[:-]?\s*(.*)$/i;

/** Six digits on their own: an Indian PIN code. */
const PINCODE = /(?<![0-9])([1-9][0-9]{5})(?![0-9])/;

/** Where the address block stops: the card's other furniture. */
const BLOCK_END =
  /^(?:vid|virtual id|aadhaar|uidai|help@|www\.|1947|\d{4}\s\d{4}\s\d{4}|government of india)/i;

/** Title case for a state, so "KARNATAKA" reads as a form expects it. */
function titleCase(value: string): string {
  return value.replace(/\w\S*/g, (word) => word[0]!.toUpperCase() + word.slice(1).toLowerCase());
}

/**
 * Is this an Aadhaar card?
 *
 * Three answers, any of which is enough: the slot the user filed it under, the
 * card naming its own issuer, or — strongest of the three — a number on it
 * that passed the Aadhaar checksum, which the rules above have already found
 * by the time this runs.
 */
function looksLikeAadhaar(ctx: Ctx): boolean {
  if (ctx.hint.documentKey === 'doc.aadhaar_card') return true;
  if (ctx.type === 'aadhaar') return true;
  return ctx.candidatesHave('id.aadhaar');
}

export function extractAddress(ctx: Ctx): void {
  if (!looksLikeAadhaar(ctx)) return;

  const start = ctx.lines.findIndex((line) => ADDRESS_LABEL.test(line.trim()));
  if (start === -1) return;

  // The block runs from the label to the card's next piece of furniture.
  const parts: string[] = [];
  const inline = (ADDRESS_LABEL.exec(ctx.lines[start]!.trim())?.[1] ?? '').trim();
  if (inline !== '') parts.push(inline);

  for (let index = start + 1; index < ctx.lines.length && parts.length < 6; index += 1) {
    const line = ctx.lines[index]!.trim();
    if (line === '' || BLOCK_END.test(line)) break;
    parts.push(line);
  }
  if (parts.length === 0) return;

  const block = parts.join(' ').replace(/\s+/g, ' ').trim();
  const evidence = block.slice(0, 120);

  // The PIN and the state have boxes of their own; what is left is the street.
  const pin = PINCODE.exec(block)?.[1];
  const state = INDIAN_STATES.find((name) =>
    new RegExp(`\\b${name.replace(/\s+/g, '\\s+')}\\b`, 'i').test(block),
  );

  let line1 = block;
  if (pin !== undefined) line1 = line1.replace(pin, '');
  if (state !== undefined) {
    line1 = line1.replace(new RegExp(`\\b${state.replace(/\s+/g, '\\s+')}\\b`, 'i'), '');
  }
  line1 = line1.replace(/[\s,-]+$/g, '').replace(/\s{2,}/g, ' ').replace(/,\s*,/g, ',').trim();

  if (line1.length >= 6) {
    ctx.push({
      key: 'address.permanent.line1',
      value: line1,
      confidence: 0.7,
      evidence,
      line: start,
      verified: false,
    });
  }

  if (pin !== undefined) {
    ctx.push({
      key: 'address.permanent.pincode',
      value: pin,
      confidence: 0.85,
      evidence,
      line: start,
      verified: false,
    });
  }

  if (state !== undefined) {
    ctx.push({
      key: 'address.permanent.state',
      value: titleCase(state),
      confidence: 0.8,
      evidence,
      line: start,
      verified: false,
    });
  }
}
