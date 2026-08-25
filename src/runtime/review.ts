/**
 * The review model (§ Phase 7).
 *
 * Pure: page state in, a structure describing what the user must look at out.
 * No DOM, no `chrome.*`, no React. The screen that renders this is the user's
 * last line of defence, and the plan is blunt about the bar — *"a user-testing
 * pass with one deliberately wrong value planted; all three should catch it.
 * If they don't, the review screen has failed its only job."*
 *
 * Two consequences shape everything here:
 *
 *  1. **The portal's label is the primary text, not our key.** The user is
 *     checking a form they can see. "Father's Name" is what they are looking
 *     for; `family.father_name` is our bookkeeping and belongs in smaller
 *     print. A review screen that leads with internal names asks the user to
 *     learn our vocabulary before they can check their own data.
 *  2. **Anything doubtful is hoisted, not merely coloured.** A flag half way
 *     down a list of forty fields is a flag nobody reads. `attention` is the
 *     subset that needs eyes, ordered by how badly it can hurt, and the screen
 *     puts it at the top.
 */

import type {
  FieldDescriptor,
  FieldOption,
  FieldRef,
  FieldTag,
  MatchResult,
  MatchSource,
  ReviewDiff,
} from '@/shared/types';
import { CONFIDENCE } from '@/shared/types';
import { sensitivityOf, isFieldKey, type FieldKey, type Sensitivity } from '@/matching/taxonomy';

/** Everything that can make a filled field worth a second look. */
export type ReviewFlag =
  /** The page refused the value. */
  | 'fill-failed'
  /** The portal requires it and it is still empty. */
  | 'required-empty'
  /** A dropdown matched by approximation rather than exactly. */
  | 'fuzzy-select'
  /** Shortened to fit the field's maxLength. */
  | 'truncated'
  /** Matched, but not confidently. */
  | 'low-confidence'
  /** Matched by the LLM (§ Phase 8), which is never fully trusted. */
  | 'llm-matched'
  /** Recognised but left blank on purpose — too uncertain to write. */
  | 'skipped-low-confidence'
  /** Aadhaar, PAN, bank account: masked until revealed. */
  | 'high-sensitivity'
  /** The user corrected this one themselves. */
  | 'user-edited';

/**
 * Severity order — and therefore the order of the attention list.
 *
 * The ranking is by *what the user loses if they miss it*. A field the page
 * rejected or a required field left blank costs a rejected application. A
 * fuzzy dropdown or a truncated value is worse: the form submits, looking
 * complete, carrying something subtly wrong.
 */
const SEVERITY: readonly ReviewFlag[] = [
  'fill-failed',
  'required-empty',
  'fuzzy-select',
  'truncated',
  'llm-matched',
  'low-confidence',
  'skipped-low-confidence',
  'user-edited',
  'high-sensitivity',
];

/** Flags that put a row in front of the user. The last two are context. */
const NEEDS_ATTENTION = new Set<ReviewFlag>(SEVERITY.slice(0, 7));

export interface ReviewRow {
  ref: FieldRef;
  /** The label as it appears on the portal. The primary text. */
  portalLabel: string;
  /** Our canonical key. Secondary text — bookkeeping, not the headline. */
  key: FieldKey | null;
  /** What is in the field right now, read back from the page. */
  value: string;
  /** Blank means blank: distinguishes "we wrote nothing" from "we wrote ''". */
  filled: boolean;
  confidence: number;
  rationale: string;
  source: MatchSource | 'taught' | null;
  flags: ReviewFlag[];
  required: boolean;
  sensitivity: Sensitivity;
  section: string;
  selector: string;
  tag: FieldTag;
  options?: FieldOption[];
  maxLength?: number;
}

export interface ReviewSection {
  id: string;
  title: string;
  refs: FieldRef[];
}

export interface ReviewCounts {
  total: number;
  filled: number;
  flagged: number;
  blank: number;
  requiredBlank: number;
}

export interface ReviewModel {
  rows: ReviewRow[];
  sections: ReviewSection[];
  /** The subset needing eyes, worst first. */
  attention: ReviewRow[];
  counts: ReviewCounts;
  /** §5's shape, for the run state machine. */
  diff: ReviewDiff;
  /** True when nothing at all was written — the screen says so plainly. */
  empty: boolean;
}

export interface ReviewRecord {
  ref: FieldRef;
  ok: boolean;
  truncated?: boolean;
  fuzzy?: boolean;
  fillFailed?: boolean;
  reason?: string;
}

export interface ReviewInput {
  fields: readonly FieldDescriptor[];
  matches: readonly MatchResult[];
  /** Per-field outcomes from the fill run. */
  records: readonly ReviewRecord[];
  /** What is in each field right now, read back from the live page. */
  values: ReadonlyMap<FieldRef, string>;
  /** Refs the user has corrected by hand in this review. */
  edits?: ReadonlySet<FieldRef>;
}

/**
 * Build the review.
 *
 * Only visible fields are included. A hidden input the user cannot see is not
 * something they can meaningfully check, and padding the list with them is how
 * a review screen becomes a thing people scroll past.
 */
export function buildReview(input: ReviewInput): ReviewModel {
  const matchByRef = new Map(input.matches.map((match) => [match.fieldRef, match]));
  const recordByRef = new Map(input.records.map((record) => [record.ref, record]));
  const edits = input.edits ?? new Set<FieldRef>();

  const rows: ReviewRow[] = [];

  for (const field of input.fields) {
    if (!field.visible) continue;

    const match = matchByRef.get(field.ref);
    const record = recordByRef.get(field.ref);
    const value = input.values.get(field.ref) ?? '';
    const key = match && isFieldKey(match.key) ? match.key : null;

    // A field is only "in the review" if we did something with it or the page
    // requires it. An untouched optional field the user must fill themselves
    // is not our business to list as though we had an opinion about it.
    const involved = record !== undefined || key !== null || field.required;
    if (!involved) continue;

    const flags = flagsFor({ field, match, record, value, key, edited: edits.has(field.ref) });

    rows.push({
      ref: field.ref,
      portalLabel: field.labelText.trim() || '(this field has no label on the page)',
      key,
      value,
      filled: record?.ok === true,
      confidence: match?.confidence ?? 0,
      rationale: match?.rationale ?? '',
      source: match?.source ?? null,
      flags,
      required: field.required,
      sensitivity: key ? sensitivityOf(key) : 'low',
      section: sectionOf(field),
      selector: field.selectors[0] ?? '',
      tag: field.tag,
      ...(field.options ? { options: field.options } : {}),
      ...(field.maxLength === undefined ? {} : { maxLength: field.maxLength }),
    });
  }

  return {
    rows,
    sections: sectionsOf(rows),
    attention: attentionOf(rows),
    counts: countsOf(rows),
    diff: diffOf(rows),
    empty: rows.every((row) => !row.filled),
  };
}

// ---------------------------------------------------------------------------
// Flags
// ---------------------------------------------------------------------------

function flagsFor(args: {
  field: FieldDescriptor;
  match: MatchResult | undefined;
  record: ReviewRecord | undefined;
  value: string;
  key: FieldKey | null;
  edited: boolean;
}): ReviewFlag[] {
  const { field, match, record, value, key, edited } = args;
  const flags: ReviewFlag[] = [];

  if (record?.fillFailed === true) flags.push('fill-failed');
  if (field.required && value.trim() === '') flags.push('required-empty');
  if (record?.fuzzy === true) flags.push('fuzzy-select');
  if (record?.truncated === true) flags.push('truncated');

  if (match && key !== null) {
    if (match.source === 'llm') flags.push('llm-matched');

    if (match.confidence < CONFIDENCE.FILL_AND_FLAG) {
      // Recognised, but too uncertain to have been written at all.
      if (record === undefined) flags.push('skipped-low-confidence');
    } else if (match.confidence < CONFIDENCE.AUTO_FILL) {
      flags.push('low-confidence');
    }
  }

  if (key !== null && sensitivityOf(key) === 'high') flags.push('high-sensitivity');
  if (edited) flags.push('user-edited');

  return sortBySeverity(flags);
}

function sortBySeverity(flags: readonly ReviewFlag[]): ReviewFlag[] {
  return [...new Set(flags)].sort((a, b) => SEVERITY.indexOf(a) - SEVERITY.indexOf(b));
}

/** The worst flag on a row, or null if it is unremarkable. */
export function worstFlag(row: ReviewRow): ReviewFlag | null {
  return row.flags.find((flag) => NEEDS_ATTENTION.has(flag)) ?? null;
}

export function needsAttention(row: ReviewRow): boolean {
  return worstFlag(row) !== null;
}

function attentionOf(rows: readonly ReviewRow[]): ReviewRow[] {
  return rows
    .filter(needsAttention)
    .sort((a, b) => SEVERITY.indexOf(worstFlag(a)!) - SEVERITY.indexOf(worstFlag(b)!));
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

/**
 * The page's own grouping, as far as the harvester could see it.
 *
 * `nearbyText` is a fieldset legend, a section heading, or the table caption
 * above the field — whatever the page used to organise itself. Borrowing the
 * portal's own structure means the review reads in the same order as the form
 * the user is looking at, which is the only ordering they can check against.
 */
function sectionOf(field: FieldDescriptor): string {
  const text = field.nearbyText.trim();
  if (text === '') return 'Other fields';
  return text.length > 60 ? `${text.slice(0, 57)}…` : text;
}

function sectionsOf(rows: readonly ReviewRow[]): ReviewSection[] {
  const sections: ReviewSection[] = [];
  const index = new Map<string, ReviewSection>();

  // Insertion order, which is document order — the order the user sees.
  for (const row of rows) {
    let section = index.get(row.section);
    if (!section) {
      section = { id: `s${index.size}`, title: row.section, refs: [] };
      index.set(row.section, section);
      sections.push(section);
    }
    section.refs.push(row.ref);
  }

  return sections;
}

// ---------------------------------------------------------------------------
// Counts and the §5 diff
// ---------------------------------------------------------------------------

function countsOf(rows: readonly ReviewRow[]): ReviewCounts {
  return {
    total: rows.length,
    filled: rows.filter((row) => row.filled).length,
    flagged: rows.filter(needsAttention).length,
    blank: rows.filter((row) => row.value.trim() === '').length,
    requiredBlank: rows.filter((row) => row.flags.includes('required-empty')).length,
  };
}

function diffOf(rows: readonly ReviewRow[]): ReviewDiff {
  const withFlag = (flag: ReviewFlag): FieldRef[] =>
    rows.filter((row) => row.flags.includes(flag)).map((row) => row.ref);

  return {
    lowConfidence: withFlag('low-confidence'),
    truncated: withFlag('truncated'),
    fuzzySelect: withFlag('fuzzy-select'),
    fillFailed: withFlag('fill-failed'),
    requiredButEmpty: withFlag('required-empty'),
  };
}

// ---------------------------------------------------------------------------
// Presentation helpers, shared by the panel and the audit log
// ---------------------------------------------------------------------------

export const FLAG_TEXT: Readonly<Record<ReviewFlag, string>> = Object.freeze({
  'fill-failed': 'The page would not accept this value',
  'required-empty': 'Required by the portal, still empty',
  'fuzzy-select': 'Dropdown matched approximately — check it is the right option',
  truncated: 'Shortened to fit the field — check nothing important was cut',
  'low-confidence': 'We are not certain this is the right field',
  'llm-matched': 'Matched by the language model, not by a rule — check it',
  'skipped-low-confidence': 'Left blank on purpose: too uncertain to guess',
  'high-sensitivity': 'Sensitive value — hidden until you reveal it',
  'user-edited': 'You corrected this',
});

/**
 * Mask a sensitive value for display.
 *
 * Shows the last four characters so the user can still tell *which* card or
 * account it is — the thing they actually need to verify — without the number
 * sitting on screen in an office.
 */
export function maskValue(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= 4) return '•'.repeat(trimmed.length);
  return `${'•'.repeat(Math.min(trimmed.length - 4, 12))}${trimmed.slice(-4)}`;
}
