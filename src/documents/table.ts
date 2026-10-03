/**
 * Tables on a page, read cell by cell (Stage 3).
 *
 * A grade card's courses are a table, and read as lines a table is a puzzle: a
 * title that wraps onto a second line becomes a course of its own with no
 * marks, and nothing says which figure is the total. PaddleOCR's table model,
 * SLANet_plus, looks at a picture of a table and answers with its structure —
 * rows, cells, which cells span two columns — and where each cell is. The text
 * in the cells is what the reader has already read; this file puts each piece
 * of it in the cell it sits in.
 *
 * Four steps, each pure, so each is tested without a browser:
 *
 *  1. `tableRegions` — where a table is, from the text already read: rows of
 *     three or more pieces of text across, one under the next. A page layout
 *     model would say so too, but no small one ships as ONNX, and the rows the
 *     reader found are already the evidence.
 *  2. `widenToRules` — the picture to show the model: out to a ruled table's
 *     own border, which its text stops short of. Cut at the text, the model saw
 *     a table with no edge and merged its header with the first row.
 *  3. `tableInput` / `decodeStructure` — the model's picture, and its answer
 *     read back as rows of cells placed on the page.
 *  4. `fillTable` — the text, cell by cell.
 *
 * Nothing here reaches beyond the device: the model is a file in the package,
 * run in the reader's own worker, like every other model the reader uses.
 */

import type { Box, RgbaImage, TableConfig } from './paddle';
import { resizeBilinear } from './paddle';

/** A table the reader found on a page, as a grid of the text in its cells. */
export interface ReadTable {
  rows: string[][];
}

/** A piece of text the reader read, and where. */
export interface PlacedText {
  text: string;
  box: Box;
}

/** A table's place on the page, and the height of a line of its text. */
export interface TableRegion {
  box: Box;
  lineHeight: number;
}

// ---- 1. where a table is ----------------------------------------------------

/** Pieces of text across one row before the row is a table's. */
const ACROSS = 3;
/** Rows of a table before it is called one: a header and two rows under it. */
const TABLE_ROWS = 3;
/** The furthest one row of a table sits below the one above it, in lines. */
const ROW_GAP_LINES = 1;

interface VisualRow {
  y0: number;
  y1: number;
  items: PlacedText[];
}

const middle = (box: Box): number => (box.y0 + box.y1) / 2;

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

/** The text in rows, top to bottom: a piece joins the row its middle sits in. */
function visualRows(items: readonly PlacedText[]): VisualRow[] {
  const rows: VisualRow[] = [];
  for (const item of [...items].sort((a, b) => middle(a.box) - middle(b.box))) {
    const centre = middle(item.box);
    const row = rows.find((candidate) => candidate.y0 <= centre && centre <= candidate.y1);
    if (row === undefined) rows.push({ y0: item.box.y0, y1: item.box.y1, items: [item] });
    else row.items.push(item);
  }
  return rows;
}

/**
 * Where the tables are, from what was read.
 *
 * A table is a run of rows with three or more pieces of text across, each
 * within a line of the one above. One row with less in it may sit between two
 * of them — a title wrapped onto a second line — when it lies within the
 * table's width; two such rows end the table, as does a gap.
 */
export function tableRegions(items: readonly PlacedText[]): TableRegion[] {
  const rows = visualRows(items.filter((item) => item.text.trim() !== ''));
  const regions: TableRegion[] = [];

  let run: VisualRow[] = [];
  const close = (): void => {
    while (run.length > 0 && run[run.length - 1]!.items.length < ACROSS) run.pop();
    if (run.filter((row) => row.items.length >= ACROSS).length >= TABLE_ROWS) {
      const inside = run.flatMap((row) => row.items);
      regions.push({
        box: {
          x0: Math.min(...inside.map((item) => item.box.x0)),
          y0: Math.min(...inside.map((item) => item.box.y0)),
          x1: Math.max(...inside.map((item) => item.box.x1)),
          y1: Math.max(...inside.map((item) => item.box.y1)),
        },
        lineHeight: median(inside.map((item) => item.box.y1 - item.box.y0)),
      });
    }
    run = [];
  };

  for (const row of rows) {
    const previous = run[run.length - 1];
    if (previous !== undefined) {
      const line = median(previous.items.map((item) => item.box.y1 - item.box.y0));
      if (row.y0 - previous.y1 > ROW_GAP_LINES * line) close();
    }

    const last = run[run.length - 1];
    if (row.items.length >= ACROSS) {
      run.push(row);
    } else if (last !== undefined && last.items.length >= ACROSS && withinWidth(row, run)) {
      run.push(row);
    } else {
      close();
    }
  }
  close();
  return regions;
}

/** Whether a row's text lies within the width of the table rows above it. */
function withinWidth(row: VisualRow, run: readonly VisualRow[]): boolean {
  const across = run.filter((candidate) => candidate.items.length >= ACROSS).flatMap((candidate) => candidate.items);
  const left = Math.min(...across.map((item) => item.box.x0));
  const right = Math.max(...across.map((item) => item.box.x1));
  return row.items.every((item) => item.box.x0 >= left && item.box.x1 <= right);
}

// ---- 2. the picture to show the model ---------------------------------------

/** How far out a ruled border is looked for, in lines of the table's text. */
const RULE_REACH_LINES = 1.5;
/** A line of pixels this dark, this much of the way along, is a rule. */
const RULE_DARK = 128;
const RULE_SHARE = 0.6;
/** The margin round an open table, which has no border, in lines. */
const OPEN_MARGIN_LINES = 0.4;

function luma(image: RgbaImage, x: number, y: number): number {
  const at = (y * image.width + x) * 4;
  return 0.299 * image.data[at]! + 0.587 * image.data[at + 1]! + 0.114 * image.data[at + 2]!;
}

/**
 * The region, out to a ruled table's border where it has one.
 *
 * Looked for on each side separately, out to a line and a half from the text:
 * the first column (or row) of pixels dark across most of the table is its
 * rule. A side with none gets a small margin. Never past the page.
 */
export function widenToRules(image: RgbaImage, region: TableRegion): Box {
  const { box, lineHeight } = region;
  const reach = Math.round(RULE_REACH_LINES * lineHeight);
  const margin = Math.round(OPEN_MARGIN_LINES * lineHeight);
  const x0 = Math.max(0, Math.floor(box.x0));
  const y0 = Math.max(0, Math.floor(box.y0));
  const x1 = Math.min(image.width, Math.ceil(box.x1));
  const y1 = Math.min(image.height, Math.ceil(box.y1));

  const darkDown = (x: number): boolean => {
    let dark = 0;
    for (let y = y0; y < y1; y += 1) if (luma(image, x, y) < RULE_DARK) dark += 1;
    return dark >= RULE_SHARE * (y1 - y0);
  };
  const darkAcross = (y: number): boolean => {
    let dark = 0;
    for (let x = x0; x < x1; x += 1) if (luma(image, x, y) < RULE_DARK) dark += 1;
    return dark >= RULE_SHARE * (x1 - x0);
  };
  const first = (from: number, step: 1 | -1, limit: number, dark: (at: number) => boolean): number | null => {
    for (let at = from, gone = 0; at >= 0 && at < limit && gone < reach; at += step, gone += 1) {
      if (dark(at)) return at;
    }
    return null;
  };

  const left = first(x0 - 1, -1, image.width, darkDown);
  const right = first(x1, 1, image.width, darkDown);
  const top = first(y0 - 1, -1, image.height, darkAcross);
  const bottom = first(y1, 1, image.height, darkAcross);

  return {
    x0: Math.max(0, left === null ? x0 - margin : left - 2),
    y0: Math.max(0, top === null ? y0 - margin : top - 2),
    x1: Math.min(image.width, right === null ? x1 + margin : right + 3),
    y1: Math.min(image.height, bottom === null ? y1 + margin : bottom + 3),
  };
}

// ---- 3. the model's picture, and its answer --------------------------------

/** A piece of a picture, as its own picture. */
function cut(image: RgbaImage, box: Box): RgbaImage {
  const x0 = Math.max(0, Math.floor(box.x0));
  const y0 = Math.max(0, Math.floor(box.y0));
  const width = Math.max(1, Math.min(image.width, Math.ceil(box.x1)) - x0);
  const height = Math.max(1, Math.min(image.height, Math.ceil(box.y1)) - y0);
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const from = ((y0 + y) * image.width + x0) * 4;
    data.set(image.data.subarray(from, from + width * 4), y * width * 4);
  }
  return { data, width, height };
}

/**
 * The table as SLANet_plus wants it: its longer side brought to the model's
 * size, normalised channel by channel in blue, green, red order — PaddleOCR
 * reads pictures as OpenCV does — and padded with zeros to a square.
 */
export function tableInput(
  image: RgbaImage,
  box: Box,
  config: Pick<TableConfig, 'size' | 'mean' | 'std' | 'scale'>,
): { data: Float32Array; ratio: number } {
  const piece = cut(image, box);
  const { size, mean, std, scale } = config;
  const ratio = size / Math.max(piece.width, piece.height);
  const width = Math.max(1, Math.min(size, Math.round(piece.width * ratio)));
  const height = Math.max(1, Math.min(size, Math.round(piece.height * ratio)));
  const small = resizeBilinear(piece, width, height);

  const plane = size * size;
  const data = new Float32Array(3 * plane);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const from = (y * width + x) * 4;
      const to = y * size + x;
      // Blue, green, red: each normalised with its own channel's numbers.
      data[to] = (small.data[from + 2]! * scale - mean[0]!) / std[0]!;
      data[plane + to] = (small.data[from + 1]! * scale - mean[1]!) / std[1]!;
      data[2 * plane + to] = (small.data[from]! * scale - mean[2]!) / std[2]!;
    }
  }
  return { data, ratio };
}

/** A cell the model found: where it is on the page, and how far it spans. */
export interface TableCell {
  box: Box;
  colspan: number;
  rowspan: number;
}

export interface TableStructure {
  rows: TableCell[][];
}

/** The tokens that open a cell, each with its place in the model's second output. */
const CELL_TOKENS = new Set(['<td>', '<td', '<td></td>']);

/**
 * The model's answer as rows of cells.
 *
 * Its first output is a token at each step — `<tr>`, `<td></td>`, ` colspan="2"`
 * — and its second, for each cell token, the cell's four corners as shares of
 * the padded square. Read up to the first end token, as PaddleOCR's own
 * `TableLabelDecode` does, and put back on the page: undo the resize, then add
 * where the picture was cut from.
 */
export function decodeStructure(
  output: { probs: Float32Array; locs: Float32Array; steps: number },
  config: TableConfig,
  placement: { ratio: number; offset: { x: number; y: number } },
): TableStructure {
  const classes = config.classes.length;
  const start = config.classes.indexOf('sos');
  const end = config.classes.indexOf('eos');
  const scale = config.size / placement.ratio;

  const rows: TableCell[][] = [];
  let row: TableCell[] | null = null;
  let cell: TableCell | null = null;

  for (let step = 0; step < output.steps; step += 1) {
    let best = 0;
    for (let c = 1; c < classes; c += 1) {
      if (output.probs[step * classes + c]! > output.probs[step * classes + best]!) best = c;
    }
    if (best === end && step > 0) break;
    if (best === start || best === end) continue;

    const token = config.classes[best]!;
    if (token === '<tr>') {
      row = [];
    } else if (token === '</tr>') {
      if (row !== null) rows.push(row);
      row = null;
    } else if (CELL_TOKENS.has(token)) {
      const corners = output.locs.subarray(step * config.locCount, (step + 1) * config.locCount);
      const xs = Array.from(corners.filter((_, i) => i % 2 === 0));
      const ys = Array.from(corners.filter((_, i) => i % 2 === 1));
      cell = {
        box: {
          x0: Math.min(...xs) * scale + placement.offset.x,
          y0: Math.min(...ys) * scale + placement.offset.y,
          x1: Math.max(...xs) * scale + placement.offset.x,
          y1: Math.max(...ys) * scale + placement.offset.y,
        },
        colspan: 1,
        rowspan: 1,
      };
      (row ??= []).push(cell);
    } else {
      const span = /^\s*(colspan|rowspan)="(\d+)"$/.exec(token);
      if (span !== null && cell !== null) cell[span[1] as 'colspan' | 'rowspan'] = Number(span[2]);
    }
  }
  if (row !== null && row.length > 0) rows.push(row);
  return { rows };
}

// ---- 4. the text, cell by cell ----------------------------------------------

/** Of a piece of text's area, how much must lie in a cell for it to be that cell's. */
const IN_CELL = 0.3;
/**
 * A piece with less than this share in its best cell, the rest in other cells
 * of its row, is split between them word by word: narrow columns the reader saw
 * as one run of text. A piece that only grazes a neighbour stays whole.
 */
const WHOLE_IN_CELL = 0.75;

function area(box: Box): number {
  return Math.max(0, box.x1 - box.x0) * Math.max(0, box.y1 - box.y0);
}

function overlap(a: Box, b: Box): number {
  return area({
    x0: Math.max(a.x0, b.x0),
    y0: Math.max(a.y0, b.y0),
    x1: Math.min(a.x1, b.x1),
    y1: Math.min(a.y1, b.y1),
  });
}

function medianOf(values: readonly number[]): number | null {
  return values.length === 0 ? null : median(values);
}

/** A cell on the grid: its first row and column, its spans, and the model's box for it. */
interface GridCell {
  r: number;
  c: number;
  rowspan: number;
  colspan: number;
  box: Box;
}

/** The cells on a grid, as a browser lays out an HTML table: each in the first free column of its row. */
function layOut(structure: TableStructure): { cells: GridCell[]; columns: number } {
  const taken: boolean[][] = [];
  const cells: GridCell[] = [];
  structure.rows.forEach((row, r) => {
    taken[r] ??= [];
    let column = 0;
    for (const cell of row) {
      while (taken[r]![column]) column += 1;
      for (let dr = 0; dr < cell.rowspan; dr += 1) {
        taken[r + dr] ??= [];
        for (let dc = 0; dc < cell.colspan; dc += 1) taken[r + dr]![column + dc] = true;
      }
      cells.push({ r, c: column, rowspan: cell.rowspan, colspan: cell.colspan, box: cell.box });
      column += cell.colspan;
    }
  });
  return { cells, columns: Math.max(0, ...taken.map((row) => row?.length ?? 0)) };
}

/**
 * Where each column — or row — starts and ends: the median of every cell that
 * starts or ends there.
 *
 * SLANet places most cells well and some badly: on the open grade card it drew
 * the header's first cell out to 287, where every row under it ends near 233,
 * and taken at its word that cell cut "Course Title" in two. A column is where
 * most of its cells say it is. Neighbours then meet halfway, so every point
 * between the first edge and the last belongs to exactly one. Null when a
 * column has no cell to say where it is.
 */
function edges(
  count: number,
  spans: ReadonlyArray<{ first: number; last: number; start: number; end: number }>,
): Array<[number, number]> | null {
  const starts = Array.from({ length: count }, (_, i) =>
    medianOf(spans.filter((span) => span.first === i).map((span) => span.start)),
  );
  const ends = Array.from({ length: count }, (_, i) =>
    medianOf(spans.filter((span) => span.last === i).map((span) => span.end)),
  );
  // A column every cell spans past takes its edges from its neighbours.
  for (let i = 1; i < count; i += 1) starts[i] ??= ends[i - 1] ?? null;
  for (let i = count - 2; i >= 0; i -= 1) ends[i] ??= starts[i + 1] ?? null;
  if (starts.some((edge) => edge === null) || ends.some((edge) => edge === null)) return null;

  const out = starts.map((start, i) => [start!, ends[i]!] as [number, number]);
  for (let i = 0; i + 1 < count; i += 1) {
    const meet = (out[i]![1] + out[i + 1]![0]) / 2;
    out[i]![1] = meet;
    out[i + 1]![0] = meet;
  }
  return out;
}

/** Text in a cell, in reading order: line by line, each line left to right. */
function readingOrder(pieces: PlacedText[]): string {
  const sorted = [...pieces].sort((a, b) => middle(a.box) - middle(b.box));
  const lines: PlacedText[][] = [];
  for (const piece of sorted) {
    const line = lines[lines.length - 1];
    const head = line?.[0];
    if (head !== undefined && middle(piece.box) <= head.box.y1) line!.push(piece);
    else lines.push([piece]);
  }
  return lines
    .map((line) =>
      line
        .sort((a, b) => a.box.x0 - b.box.x0)
        .map((piece) => piece.text.trim())
        .join(' '),
    )
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The table's text, as a grid.
 *
 * The cells are laid out first, and each is given the edges of its columns and
 * rows (`edges`) rather than the box the model drew for it alone. Each piece of
 * text then goes to the cell most of it lies in. A piece split across cells of
 * its row — narrow columns the reader saw as one run of text, "45 52" — is
 * shared out word by word, each word placed by where it falls along the piece.
 * A cell spanning columns keeps its text in the first of them, the rest left
 * empty, so every row has a cell for every column.
 */
export function fillTable(structure: TableStructure, items: readonly PlacedText[]): ReadTable {
  const { cells, columns } = layOut(structure);
  const rows = structure.rows.length;

  const across = edges(
    columns,
    cells.map((cell) => ({ first: cell.c, last: cell.c + cell.colspan - 1, start: cell.box.x0, end: cell.box.x1 })),
  );
  const down = edges(
    rows,
    cells.map((cell) => ({
      first: cell.r,
      last: Math.min(rows - 1, cell.r + cell.rowspan - 1),
      start: cell.box.y0,
      end: cell.box.y1,
    })),
  );
  const boxes: Box[] = cells.map((cell) =>
    across === null || down === null
      ? cell.box
      : {
          x0: across[cell.c]![0],
          x1: across[Math.min(columns - 1, cell.c + cell.colspan - 1)]![1],
          y0: down[cell.r]![0],
          y1: down[Math.min(rows - 1, cell.r + cell.rowspan - 1)]![1],
        },
  );

  const pieces = cells.map(() => [] as PlacedText[]);
  for (const item of items) {
    const size = area(item.box);
    if (size === 0 || item.text.trim() === '' || boxes.length === 0) continue;
    const shares = boxes.map((box) => overlap(box, item.box) / size);
    let best = 0;
    for (let index = 1; index < shares.length; index += 1) if (shares[index]! > shares[best]!) best = index;
    if (shares[best]! === 0) continue;

    const words = item.text.trim().split(/\s+/);
    const homes = cells
      .map((cell, index) => ({ cell, index, box: boxes[index]!, share: shares[index]! }))
      .filter((home) => home.share > 0 && home.cell.r === cells[best]!.r);
    const inTable = homes.reduce((sum, home) => sum + home.share, 0);
    if (words.length >= 2 && shares[best]! < WHOLE_IN_CELL && homes.length >= 2 && inTable >= IN_CELL) {
      // Each word placed by where its middle falls along the piece, by letters.
      const length = item.text.trim().length;
      const width = item.box.x1 - item.box.x0;
      const centre = (box: Box) => (box.x0 + box.x1) / 2;
      let offset = 0;
      for (const word of words) {
        const x = item.box.x0 + ((offset + word.length / 2) / length) * width;
        offset += word.length + 1;
        const home =
          homes.find((candidate) => candidate.box.x0 <= x && x < candidate.box.x1) ??
          homes.reduce((near, candidate) =>
            Math.abs(centre(candidate.box) - x) < Math.abs(centre(near.box) - x) ? candidate : near,
          );
        const half = ((word.length / length) * width) / 2;
        pieces[home.index]!.push({ text: word, box: { ...item.box, x0: x - half, x1: x + half } });
      }
      continue;
    }

    if (shares[best]! >= IN_CELL) pieces[best]!.push(item);
  }

  const grid: string[][] = Array.from({ length: rows }, () => Array.from({ length: columns }, () => ''));
  cells.forEach((cell, index) => {
    grid[cell.r]![cell.c] = readingOrder(pieces[index]!);
  });
  return { rows: grid };
}
