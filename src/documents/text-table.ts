/**
 * Tables in a PDF's own text.
 *
 * A grade card downloaded from a university portal is a PDF with real text in
 * it, read exactly rather than recognised (`pdf-text.ts`). Its courses are a
 * table, and read as lines a table loses what the photo path's table model
 * gives back (`table.ts`): which figure is the total, which cell the grade —
 * and a title wrapped onto a second line becomes a course of its own. There is
 * no picture here for that model, and none is needed: every piece of text
 * comes with where it sits, exactly.
 *
 * So the grid is laid out from the text alone:
 *
 *  1. Fragments become cells: pieces on one baseline join while the gap
 *     between them is a word's space, not a cell's padding — some PDFs place
 *     every word, or every letter, on its own.
 *  2. The table is found as the photo path finds it (`tableRegions`): rows of
 *     three or more cells across. A PDF's rows stand further apart, for their
 *     size, than a reader's boxes do, and a title may wrap onto several lines.
 *  3. A cell's further lines — closer to the line above than rows are to each
 *     other — are folded into it.
 *  4. Columns are where the body's cells sit, each heading placed in the
 *     column under it; a heading over a column no row filled is a column too.
 *
 * Pure: fragments in, grids out. pdf.js stays in `pdf-text.ts`.
 */

import type { Box } from './paddle';
import { tableRegions, visualRows, type PlacedText, type ReadTable, type VisualRow } from './table';

/** A piece of a PDF's text as pdf.js gives it: points, the origin at the bottom left, `y` its baseline. */
export interface TextFragment {
  text: string;
  x: number;
  y: number;
  width: number;
  /** The font's size, near enough: how tall a line of it is. */
  height: number;
}

/** Pieces closer than this, in lines, are one cell's words; further apart, two cells. */
const WORD_GAP = 0.6;
/** Pieces closer than this, in lines, are one word's letters, joined without a space. */
const LETTER_GAP = 0.15;
/** How far apart a PDF table's rows may stand, in lines. */
const ROW_GAP_LINES = 2;
/** How many lines a wrapped cell may run to. */
const CELL_LINES = 3;
/** Columns closer than this, in lines, are one column. */
const COLUMN_SLACK = 0.3;

/** The fragments as cells: one piece of text per run of a line, in boxes measured downward. */
function cellsOf(fragments: readonly TextFragment[]): PlacedText[] {
  const pieces = fragments
    .filter((fragment) => fragment.text.trim() !== '' && fragment.height > 0)
    .sort((a, b) => b.y - a.y || a.x - b.x);

  // One baseline at a time: within a third of a line is the same baseline.
  const lines: TextFragment[][] = [];
  for (const piece of pieces) {
    const line = lines[lines.length - 1];
    const head = line?.[0];
    if (head !== undefined && Math.abs(head.y - piece.y) <= head.height / 3) line!.push(piece);
    else lines.push([piece]);
  }

  const cells: PlacedText[] = [];
  for (const line of lines) {
    line.sort((a, b) => a.x - b.x);
    let current: { text: string; x0: number; x1: number; y: number; height: number } | null = null;
    const finish = () => {
      if (current === null) return;
      // Measured downward, as the photo path's boxes are: the top of the text, then its baseline.
      cells.push({
        text: current.text.trim(),
        box: { x0: current.x0, x1: current.x1, y0: -current.y - current.height, y1: -current.y },
      });
    };
    for (const piece of line) {
      const gap = current === null ? Infinity : piece.x - current.x1;
      if (current !== null && gap <= WORD_GAP * piece.height) {
        current.text += gap > LETTER_GAP * piece.height ? ` ${piece.text.trim()}` : piece.text.trim();
        current.x1 = Math.max(current.x1, piece.x + piece.width);
      } else {
        finish();
        current = { text: piece.text.trim(), x0: piece.x, x1: piece.x + piece.width, y: piece.y, height: piece.height };
      }
    }
    finish();
  }
  return cells;
}

/** The gaps between rows, from one row's baseline down to the next row's top. */
function gapsBetween(rows: readonly VisualRow[]): number[] {
  return rows.slice(1).map((row, index) => row.y0 - rows[index]!.y1);
}

/**
 * The region's rows, a wrapped cell's further lines folded into the row above.
 *
 * Rows stand apart by a gap most of the table shares; a cell's lines sit
 * closer. The usual gap is taken as the one three quarters of the way up the
 * table's gaps, so a table whose every title wraps still knows its rows' gap.
 */
function foldedRows(rows: VisualRow[]): VisualRow[] {
  const gaps = gapsBetween(rows).sort((a, b) => a - b);
  if (gaps.length === 0) return rows;
  const usual = gaps[Math.min(gaps.length - 1, Math.floor(gaps.length * 0.75))]!;

  const folded: VisualRow[] = [];
  for (const row of rows) {
    const above = folded[folded.length - 1];
    if (above !== undefined && row.y0 - above.y1 < usual / 2) {
      above.items.push(...row.items);
      above.y1 = Math.max(above.y1, row.y1);
    } else {
      folded.push({ y0: row.y0, y1: row.y1, items: [...row.items] });
    }
  }
  return folded;
}

function overlap(a: { x0: number; x1: number }, b: { x0: number; x1: number }): number {
  return Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0));
}

/**
 * The columns: where the body's cells sit, side by side, each run of cells
 * that overlap one column. The heading row is left out of drawing them — a
 * heading may span two columns — and then placed: a heading over no column
 * marks one of its own, which the rows left empty.
 */
function columnsOf(rows: readonly VisualRow[], slack: number): Array<{ x0: number; x1: number }> {
  const spans = rows
    .slice(1)
    .flatMap((row) => row.items.map((item) => ({ x0: item.box.x0, x1: item.box.x1 })))
    .sort((a, b) => a.x0 - b.x0);

  const columns: Array<{ x0: number; x1: number }> = [];
  for (const span of spans) {
    const last = columns[columns.length - 1];
    if (last !== undefined && span.x0 <= last.x1 + slack) last.x1 = Math.max(last.x1, span.x1);
    else columns.push({ ...span });
  }
  for (const item of rows[0]?.items ?? []) {
    if (!columns.some((column) => overlap(column, item.box) > 0)) columns.push({ x0: item.box.x0, x1: item.box.x1 });
  }
  return columns.sort((a, b) => a.x0 - b.x0);
}

/** A row's cells laid along the columns: each piece in the column it overlaps most, top to bottom, left to right. */
function lay(row: VisualRow, columns: ReadonlyArray<{ x0: number; x1: number }>): string[] {
  const cells: PlacedText[][] = columns.map(() => []);
  for (const item of row.items) {
    let best = 0;
    columns.forEach((column, index) => {
      if (overlap(column, item.box) > overlap(columns[best]!, item.box)) best = index;
    });
    cells[best]!.push(item);
  }
  return cells.map((pieces) =>
    pieces
      .sort((a, b) => a.box.y0 - b.box.y0 || a.box.x0 - b.box.x0)
      .map((piece) => piece.text)
      .join(' ')
      .trim(),
  );
}

const within = (box: Box, region: Box) => {
  const x = (box.x0 + box.x1) / 2;
  const y = (box.y0 + box.y1) / 2;
  return x >= region.x0 && x <= region.x1 && y >= region.y0 && y <= region.y1;
};

/** The tables on one page of a PDF's text, each a grid of its cells' text. */
export function tablesFromText(fragments: readonly TextFragment[]): ReadTable[] {
  const cells = cellsOf(fragments);
  const tables: ReadTable[] = [];

  for (const region of tableRegions(cells, { rowGapLines: ROW_GAP_LINES, looseRows: CELL_LINES })) {
    const rows = foldedRows(visualRows(cells.filter((cell) => within(cell.box, region.box))));
    if (rows.length < 2) continue;
    const columns = columnsOf(rows, COLUMN_SLACK * region.lineHeight);
    if (columns.length < 2) continue;
    tables.push({ rows: rows.map((row) => lay(row, columns)) });
  }
  return tables;
}
