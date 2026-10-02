/**
 * From boxes on a page to lines the field rules can read (§ reading a document).
 *
 * PaddleOCR returns one box per piece of text and where it sits. The rules read
 * lines — "Register No. : 800417" — so this puts the boxes back into lines, and
 * adds what a row-by-row join cannot see: which value belongs to which label.
 *
 * ## Why rows alone are not enough
 *
 * A Karnataka certificate prints each label twice, Kannada above English, and
 * its value once, centred between them. Joined row by row, the value sits on
 * neither label's line, and a rule looking for the value after "Candidate's
 * Name" finds the next label instead. So values are also paired with the label
 * to their left that they overlap vertically, and those pairs come first.
 *
 * ## What is dropped
 *
 * The English model reads a Kannada word as confident-looking nonsense, but not
 * confidently: measured on the user's own cards, every real English line read
 * at 0.87 or above and every guessed-at Kannada word between 0.22 and 0.62. A
 * box below `SCRIPT_MISREAD_BELOW` is that nonsense, and it is kept out of the
 * rules' way.
 *
 * Pure: boxes in, text out.
 */

import type { ReadItem } from './paddle-reader';

/**
 * Below this, a box is the English model's guess at another alphabet.
 *
 * Measured, not chosen: on the 2nd PUC card and the e-Aadhaar letter every real
 * English line scored 0.87–1.00, and every Kannada word read by the English
 * model scored 0.22–0.62. 0.7 sits between, with room on both sides.
 */
export const SCRIPT_MISREAD_BELOW = 0.7;

/**
 * A gap wider than this many line heights separates two panels.
 *
 * Measured: the cells of a marks table sit 6–17 line heights apart and belong on
 * one line; the two panels of an e-Aadhaar letter sit 23–30 apart and do not.
 */
const COLUMN_GAP = 20;

/**
 * A value may sit at most this many line heights to the right of its label.
 *
 * Far enough for a table's total ("Total Marks" to its first figure, 17 on the
 * PUC card), not so far that a label reaches across into the next column (35).
 */
const LABEL_REACH = 25;

/** A value must overlap its label vertically by at least this share. */
const MIN_OVERLAP = 0.3;

/**
 * The words that make a short piece of text a label.
 *
 * A label names a box on a form; a value fills one. What separates them is
 * vocabulary, not position — "KANNADA" at the start of a table row is a value,
 * "Register No." beside it is a label.
 */
const LABEL_WORDS =
  /\b(?:name|no|number|year|date|dob|birth|code|school|college|result|total|type|medium|register|registration|roll|mother|father|guardian|class|grade|gender|sex|category|caste|income|certificate|district|state|taluk|village|address|pin|pincode|mobile|phone|email|board|university|exam|examination|marks|percentage|stream|course|branch|semester|sats|enrolment|vid)\b/i;

interface Placed {
  text: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  h: number;
  cy: number;
}

function isLabel(box: Placed): boolean {
  return box.text.length <= 40 && /[A-Za-z]{2}/.test(box.text) && (LABEL_WORDS.test(box.text) || /:\s*$/.test(box.text));
}

/** How much of the smaller box's height the two share. */
function verticalOverlap(a: Placed, b: Placed): number {
  const shared = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
  return shared <= 0 ? 0 : shared / Math.min(a.h, b.h);
}

/** A value, without the brace or colon some cards print before it. */
function cleanValue(text: string): string {
  return text.replace(/^[\s})\]:;|-]+/, '').trim();
}

/** A label, without its trailing colon — the pair supplies one. */
function cleanLabel(text: string): string {
  return text.replace(/[\s:]+$/, '').trim();
}

/** A line of the page, and the box that holds every piece of it. */
export interface LaidLine {
  text: string;
  box: { x0: number; y0: number; x1: number; y1: number };
}

/** The smallest box around a set of placed pieces. */
function around(pieces: readonly Placed[]): LaidLine['box'] {
  return {
    x0: Math.min(...pieces.map((p) => p.x0)),
    y0: Math.min(...pieces.map((p) => p.y0)),
    x1: Math.max(...pieces.map((p) => p.x1)),
    y1: Math.max(...pieces.map((p) => p.y1)),
  };
}

/** The page as text: `layoutLines`, one line per line. */
export function layoutText(items: readonly ReadItem[]): string {
  return layoutLines(items)
    .map((line) => line.text)
    .join('\n');
}

/**
 * The page as lines, each remembering where it sat.
 *
 * The text is what the field rules read; the box is what lets the suggestion
 * screen show the piece of the card a value was read from, so the user checks
 * the pixels rather than the reading.
 */
export function layoutLines(items: readonly ReadItem[]): LaidLine[] {
  const boxes: Placed[] = items
    .filter((item) => item.score >= SCRIPT_MISREAD_BELOW && item.text.trim() !== '')
    .map((item) => ({
      text: item.text.trim(),
      x0: item.box.x0,
      y0: item.box.y0,
      x1: item.box.x1,
      y1: item.box.y1,
      h: Math.max(1, item.box.y1 - item.box.y0),
      cy: (item.box.y0 + item.box.y1) / 2,
    }));
  if (boxes.length === 0) return [];

  const heights = boxes.map((b) => b.h).sort((a, b) => a - b);
  const lineHeight = heights[Math.floor(heights.length / 2)]!;

  // ---- label : value pairs -------------------------------------------------
  const labels = boxes.filter(isLabel);
  const claimed = new Map<Placed, Placed[]>();

  for (const value of boxes) {
    if (isLabel(value)) continue;

    let best: Placed | undefined;
    let bestOverlap = 0;
    for (const label of labels) {
      if (label.x1 > value.x0 + lineHeight * 0.5) continue; // not to the left
      if (value.x0 - label.x1 > lineHeight * LABEL_REACH) continue; // too far
      const overlap = verticalOverlap(label, value);
      if (overlap < MIN_OVERLAP) continue;
      // The label it overlaps most; among equals, the nearest.
      if (overlap > bestOverlap || (overlap === bestOverlap && best !== undefined && label.x1 > best.x1)) {
        best = label;
        bestOverlap = overlap;
      }
    }
    if (best === undefined) continue;
    const list = claimed.get(best) ?? [];
    list.push(value);
    claimed.set(best, list);
  }

  const paired: Array<{ y: number; x: number; line: LaidLine }> = [];
  for (const [label, values] of claimed) {
    values.sort((a, b) => a.x0 - b.x0);
    // A value line stops at the first wide gap: beyond it is another column.
    const run: Placed[] = [];
    for (const value of values) {
      const previous = run.at(-1);
      if (previous !== undefined && value.x0 - previous.x1 > lineHeight * COLUMN_GAP) break;
      run.push(value);
    }
    const value = run.map((v) => cleanValue(v.text)).filter((t) => t !== '').join(' ');
    if (value === '') continue;
    paired.push({
      y: label.cy,
      x: label.x0,
      line: { text: `${cleanLabel(label.text)} : ${value}`, box: around([label, ...run]) },
    });
  }
  paired.sort((a, b) => a.y - b.y || a.x - b.x);

  // ---- rows, split into columns at wide gaps -------------------------------
  const sorted = [...boxes].sort((a, b) => a.cy - b.cy);
  const rows: Placed[][] = [];
  for (const box of sorted) {
    const row = rows.find((candidate) => {
      const cy = candidate.reduce((sum, b) => sum + b.cy, 0) / candidate.length;
      return Math.abs(cy - box.cy) < 0.5 * Math.min(lineHeight, box.h);
    });
    if (row) row.push(box);
    else rows.push([box]);
  }

  const lines: LaidLine[] = [];
  const flush = (segment: Placed[]) => {
    if (segment.length === 0) return;
    lines.push({ text: segment.map((piece) => piece.text).join(' '), box: around(segment) });
  };
  for (const row of rows) {
    row.sort((a, b) => a.x0 - b.x0);
    let segment: Placed[] = [];
    let lastX1 = -Infinity;
    for (const box of row) {
      if (segment.length > 0 && box.x0 - lastX1 > lineHeight * COLUMN_GAP) {
        flush(segment);
        segment = [];
      }
      segment.push(box);
      lastX1 = box.x1;
    }
    flush(segment);
  }

  // One line per entry, always: a line break inside one would put the text
  // and the boxes out of step for every line after it.
  return [...paired.map((p) => p.line), ...lines].map((line) => ({
    ...line,
    text: line.text.replace(/\s*\n\s*/g, ' '),
  }));
}
