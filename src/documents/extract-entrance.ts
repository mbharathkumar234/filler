/**
 * An entrance exam's own paperwork (§ reading a document).
 *
 * A KEA admission ticket, a rank card, a NEET admit card: papers whose whole
 * purpose is to carry numbers a portal will ask for later, and which a student
 * copies by hand from a printout because they mean nothing to remember.
 *
 * The exam is read alongside its numbers, on purpose. `entrance.*` holds one
 * exam, so a CET number arriving while a NEET number is stored would be a
 * silent swap; showing the exam name beside the number makes that visible on the
 * suggestion screen, where the user can see both and decide.
 */

import { labelledValue, type Ctx } from './extract';

/** The slots that hold an exam's paperwork. */
const ENTRANCE_SLOTS: ReadonlySet<string> = new Set([
  'doc.entrance_application_form',
  'doc.entrance_fee_receipt',
  'doc.entrance_admission_ticket',
  'doc.entrance_result',
  'doc.entrance_rank_card',
  'doc.entrance_verification_slip',
  'doc.entrance_claim_verification',
  'doc.entrance_option_entry',
  'doc.seat_allotment_letter',
]);

/**
 * The exams, by the name a portal's dropdown uses.
 *
 * Order matters: KCET's own paper says "Common Entrance Test" and is issued by
 * the Karnataka Examinations Authority, and both of those would also match a
 * looser pattern for some other state's CET, so the specific names come first.
 */
const EXAMS: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  { name: 'KCET', pattern: /\bk-?cet\b|\bugcet\b|karnataka examinations authority|\bkea\b/i },
  { name: 'COMEDK', pattern: /\bcomedk\b/i },
  { name: 'NEET', pattern: /\bneet\b/i },
  { name: 'JEE Main', pattern: /\bjee\s*\(?\s*main/i },
  { name: 'JEE Advanced', pattern: /\bjee\s*\(?\s*advanced/i },
  { name: 'GATE', pattern: /\bgate\s*(?:20\d\d|examination)\b/i },
  { name: 'CAT', pattern: /common admission test\b/i },
  { name: 'NATA', pattern: /\bnata\b/i },
  { name: 'CUET', pattern: /\bcuet\b/i },
];

const REGISTRATION_LABEL =
  /^(?:cet\s*(?:no\.?|number)|application\s*(?:no\.?|number)|registration\s*(?:no\.?|number)|reg\.?\s*no\.?)\s*[:-]?\s*(.*)$/i;
const ROLL_LABEL =
  /^(?:roll\s*(?:no\.?|number)|hall\s*ticket\s*(?:no\.?|number)|admission\s*ticket\s*(?:no\.?|number)|seat\s*(?:no\.?|number))\s*[:-]?\s*(.*)$/i;
const RANK_LABEL = /^(?:[A-Za-z ]{0,20}\brank)\s*[:-]?\s*(.*)$/i;
const SCORE_LABEL =
  /^(?:(?:total\s+)?marks(?:\s+(?:obtained|scored))?|score|total\s+score)\s*[:-]?\s*(.*)$/i;

/** An exam number: letters and digits, no spaces, long enough to be one. */
function looksLikeExamNumber(value: string): boolean {
  return /^[A-Z]{0,4}[0-9][0-9A-Z/-]{4,20}$/i.test(value.trim());
}

/** A rank or a score: digits, and not a year pretending to be one. */
function looksLikeCount(value: string): boolean {
  return /^[0-9]{1,7}(?:\.[0-9]{1,4})?$/.test(value.trim());
}

export function extractEntrance(ctx: Ctx): void {
  const slot = ctx.hint.documentKey;
  const exam = EXAMS.find((entry) => entry.pattern.test(ctx.joined));

  // An exam's paper, or nothing. A marks card also prints a register number and
  // a total, and neither of those belongs to an entrance exam.
  const isEntrancePaper = (slot !== undefined && ENTRANCE_SLOTS.has(slot)) || exam !== undefined;
  if (!isEntrancePaper) return;

  if (exam !== undefined) {
    const line = ctx.lines.findIndex((text) => exam.pattern.test(text));
    ctx.push({
      key: 'entrance.exam_name',
      value: exam.name,
      confidence: 0.8,
      evidence: (ctx.lines[line] ?? '').trim(),
      line: Math.max(line, 0),
      verified: false,
    });
  }

  type NumberKey =
    | 'entrance.registration_number'
    | 'entrance.roll_number'
    | 'entrance.rank'
    | 'entrance.score';

  const put = (
    key: NumberKey,
    found: { value: string; line: number; evidence: string } | null,
    confidence: number,
  ): void => {
    if (found === null) return;
    ctx.push({
      key,
      value: found.value,
      confidence,
      evidence: found.evidence,
      line: found.line,
      verified: false,
    });
  };

  const labelled = (label: RegExp, accept: (value: string) => boolean) =>
    labelledValue(ctx, label, accept);

  put('entrance.registration_number', labelled(REGISTRATION_LABEL, looksLikeExamNumber), 0.85);
  put('entrance.roll_number', labelled(ROLL_LABEL, looksLikeExamNumber), 0.85);
  put('entrance.rank', labelled(RANK_LABEL, looksLikeCount), 0.8);
  put('entrance.score', labelled(SCORE_LABEL, looksLikeCount), 0.75);

  // The year the exam was sat: printed in its title far more often than labelled.
  const YEAR = /(?<![0-9])(20[0-9]{2})(?![0-9])/;
  const yearLine = ctx.lines.findIndex((text) => YEAR.test(text));
  const year = yearLine === -1 ? undefined : YEAR.exec(ctx.lines[yearLine]!)?.[1];
  if (year !== undefined && Number(year) <= new Date().getUTCFullYear()) {
    ctx.push({
      key: 'entrance.year',
      value: year,
      confidence: 0.7,
      evidence: ctx.lines[yearLine]!.trim(),
      line: yearLine,
      verified: false,
    });
  }
}
