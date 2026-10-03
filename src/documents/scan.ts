/**
 * A phone photo made a scan (§ Stage 2).
 *
 * PaddleOCR's UVDoc flattens a page photographed curled or at an angle. Measured
 * on a made-up marks card photographed lying curled on a table, it put every
 * row back in line — read as photographed, three subjects' marks paired with
 * the wrong subject. On a page that was already flat it does harm: it takes the
 * margins for background and stretches the page into the frame, cutting a
 * letter off the edge. So this module decides when it runs, and finishes what
 * it leaves:
 *
 *  - `hasBackground`: is there something other than the page around it — a
 *    table, a desk? A scan or a PDF page has paper to its edges.
 *  - `trimBackground`: the bands of table UVDoc leaves at the edges, cut off.
 *  - `evenLighting`: the light evened out, so the page reads as paper rather
 *    than as a photograph of paper — without bleaching a photograph printed
 *    on it.
 *
 * Pure: pixels in, pixels out, so every threshold is tested without a browser.
 */

import type { RgbaImage } from './paddle';

interface Colour {
  r: number;
  g: number;
  b: number;
  /** Luminance, 0–255. */
  l: number;
}

const luminance = (r: number, g: number, b: number) => 0.299 * r + 0.587 * g + 0.114 * b;

function colourAt(image: RgbaImage, x: number, y: number): Colour {
  const at = (y * image.width + x) * 4;
  const r = image.data[at]!;
  const g = image.data[at + 1]!;
  const b = image.data[at + 2]!;
  return { r, g, b, l: luminance(r, g, b) };
}

/** Roughly `samples` evenly spread points of a rectangle, never fewer than one per row. */
function spread(x0: number, y0: number, x1: number, y1: number, samples: number): Array<[number, number]> {
  const step = Math.max(1, Math.floor(Math.sqrt(((x1 - x0) * (y1 - y0)) / samples)));
  const points: Array<[number, number]> = [];
  for (let y = y0; y < y1; y += step) for (let x = x0; x < x1; x += step) points.push([x, y]);
  return points;
}

const percentile = (values: number[], share: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(share * sorted.length))] ?? 0;
};

/**
 * The page's own colour: the bright end of the middle of the frame, where the
 * page is. Not white — a passbook is lavender, a certificate cream — and not
 * the median, which a page dense with print pulls towards ink.
 */
export function paperColour(image: RgbaImage): Colour {
  const { width, height } = image;
  const points = spread(Math.floor(width * 0.25), Math.floor(height * 0.25), Math.ceil(width * 0.75), Math.ceil(height * 0.75), 4000);
  const colours = points.map(([x, y]) => colourAt(image, x, y));
  const r = percentile(colours.map((c) => c.r), 0.7);
  const g = percentile(colours.map((c) => c.g), 0.7);
  const b = percentile(colours.map((c) => c.b), 0.7);
  return { r, g, b, l: luminance(r, g, b) };
}

/** Paper in shadow is still paper: as dark as this share of the page, and the same colour. */
const SHADOW_FLOOR = 0.55;
/** How far a pixel's colour, brightness aside, may stray from the paper's. */
const HUE_TOLERANCE = 0.15;

function isPaper(pixel: Colour, paper: Colour): boolean {
  if (pixel.l < SHADOW_FLOOR * paper.l) return false;
  const k = pixel.l + 1;
  const p = paper.l + 1;
  return (
    Math.abs(pixel.r / k - paper.r / p) <= HUE_TOLERANCE &&
    Math.abs(pixel.g / k - paper.g / p) <= HUE_TOLERANCE &&
    Math.abs(pixel.b / k - paper.b / p) <= HUE_TOLERANCE
  );
}

/** The frame's outer band: this share of each side. */
const BORDER = 0.03;
/** At least this share of that band not paper, and the photo has something around the page. */
const BACKGROUND_SHARE = 0.4;

function borderPoints(image: RgbaImage): Array<[number, number]> {
  const { width, height } = image;
  const bw = Math.max(2, Math.round(width * BORDER));
  const bh = Math.max(2, Math.round(height * BORDER));
  return [
    ...spread(0, 0, width, bh, 800),
    ...spread(0, height - bh, width, height, 800),
    ...spread(0, bh, bw, height - bh, 800),
    ...spread(width - bw, bh, width, height - bh, 800),
  ];
}

/**
 * Is there something other than the page around it?
 *
 * The edges of the frame against the page's own colour: a page photographed on
 * a table is ringed by table; a scan, a PDF page, a photo the page fills, has
 * paper — or the paper's own shadow — to its edges.
 */
export function hasBackground(image: RgbaImage): boolean {
  const paper = paperColour(image);
  const points = borderPoints(image);
  const other = points.filter(([x, y]) => !isPaper(colourAt(image, x, y), paper)).length;
  return points.length > 0 && other / points.length >= BACKGROUND_SHARE;
}

/**
 * The colour of what is around the page — the table, the desk — from the
 * frame's edges; `null` when there is nothing around it.
 */
export function backgroundColour(image: RgbaImage): { r: number; g: number; b: number } | null {
  if (!hasBackground(image)) return null;
  const paper = paperColour(image);
  const outside = borderPoints(image)
    .map(([x, y]) => colourAt(image, x, y))
    .filter((colour) => !isPaper(colour, paper));
  if (outside.length === 0) return null;
  return {
    r: percentile(outside.map((c) => c.r), 0.5),
    g: percentile(outside.map((c) => c.g), 0.5),
    b: percentile(outside.map((c) => c.b), 0.5),
  };
}

/** Never more than this share of a side is cut: past it, it is page, not table. */
const MAX_TRIM = 0.2;
/** How near the table's colour a pixel must be to count as table. */
const TABLE_TOLERANCE = 40;

/**
 * The bands of table left at the edges of a flattened page, cut off.
 *
 * The table is whatever is not paper at the frame's edge — or, when the photo
 * the page was flattened from is known, the colour around the page in that
 * (`backgroundColour`), which sees a band left along a single side. A row or
 * column that is mostly that colour is table. Ink is never mistaken for it — a
 * page's top rule, its first line of print — unless the ink is the table's
 * colour.
 */
export function trimBackground(image: RgbaImage, known?: { r: number; g: number; b: number }): RgbaImage {
  const { width, height } = image;
  const paper = paperColour(image);
  // A page with print to its edges is not a page on a table; nothing to cut.
  const table = known ?? backgroundColour(image);
  if (table === null) return image;
  const isTable = (x: number, y: number) => {
    const c = colourAt(image, x, y);
    return (
      Math.abs(c.r - table.r) <= TABLE_TOLERANCE &&
      Math.abs(c.g - table.g) <= TABLE_TOLERANCE &&
      Math.abs(c.b - table.b) <= TABLE_TOLERANCE &&
      !isPaper(c, paper)
    );
  };
  const rowIsTable = (y: number, x0: number, x1: number) => {
    let count = 0;
    let total = 0;
    for (let x = x0; x < x1; x += Math.max(1, Math.floor((x1 - x0) / 200))) {
      total += 1;
      if (isTable(x, y)) count += 1;
    }
    return total > 0 && count / total >= 0.5;
  };
  const columnIsTable = (x: number, y0: number, y1: number) => {
    let count = 0;
    let total = 0;
    for (let y = y0; y < y1; y += Math.max(1, Math.floor((y1 - y0) / 200))) {
      total += 1;
      if (isTable(x, y)) count += 1;
    }
    return total > 0 && count / total >= 0.5;
  };

  const maxRows = Math.floor(height * MAX_TRIM);
  const maxColumns = Math.floor(width * MAX_TRIM);
  let top = 0;
  while (top < maxRows && rowIsTable(top, 0, width)) top += 1;
  let bottom = height;
  while (height - bottom < maxRows && rowIsTable(bottom - 1, 0, width)) bottom -= 1;
  let left = 0;
  while (left < maxColumns && columnIsTable(left, top, bottom)) left += 1;
  let right = width;
  while (width - right < maxColumns && columnIsTable(right - 1, top, bottom)) right -= 1;

  if (top === 0 && bottom === height && left === 0 && right === width) return image;
  return crop(image, left, top, right - left, bottom - top);
}

function crop(image: RgbaImage, left: number, top: number, width: number, height: number): RgbaImage {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const from = ((top + y) * image.width + left) * 4;
    data.set(image.data.subarray(from, from + width * 4), y * width * 4);
  }
  return { data, width, height };
}

/** Paper is brought to this luminance. */
const PAPER_WHITE = 245;

/**
 * The light evened out: the page as paper, not as a photograph of paper.
 *
 * The light across a photographed page changes smoothly — brighter by the
 * window, darker under the hand — so it is fitted as a smooth surface
 * (quadratic in x and y) to the paper alone, and divided out. Blocks that are
 * not paper — a photograph printed on the page, a run of heavy print — are left
 * out of the fit, which is what keeps a passport photo on an ID card from being
 * bleached white the way dividing by a blurred copy of the page bleaches it.
 */
export function evenLighting(image: RgbaImage): RgbaImage {
  const { width, height, data } = image;

  // The brightest pixel of each block: the paper in it, where there is any.
  const block = Math.max(1, Math.ceil(Math.max(width, height) / 64));
  const columns = Math.ceil(width / block);
  const rows = Math.ceil(height / block);
  const brightest = new Float32Array(columns * rows);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const at = (y * width + x) * 4;
      const l = luminance(data[at]!, data[at + 1]!, data[at + 2]!);
      const cell = Math.floor(y / block) * columns + Math.floor(x / block);
      if (l > brightest[cell]!) brightest[cell] = l;
    }
  }

  // Blocks bright enough to be paper, by the page's own standard.
  const reference = percentile([...brightest], 0.9);
  const samples: Array<[number, number, number]> = [];
  for (let by = 0; by < rows; by += 1) {
    for (let bx = 0; bx < columns; bx += 1) {
      const l = brightest[by * columns + bx]!;
      if (l >= 0.5 * reference) samples.push([(bx + 0.5) / columns, (by + 0.5) / rows, l]);
    }
  }
  const surface = fitQuadratic(samples) ?? (() => reference);

  const out = new Uint8ClampedArray(data.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const at = (y * width + x) * 4;
      const light = Math.max(surface(x / width, y / height), 0.3 * reference, 1);
      const gain = PAPER_WHITE / light;
      out[at] = data[at]! * gain;
      out[at + 1] = data[at + 1]! * gain;
      out[at + 2] = data[at + 2]! * gain;
      out[at + 3] = data[at + 3]!;
    }
  }
  return { data: out, width, height };
}

/** Least squares for l = a + bx + cy + dx² + exy + fy², over (x, y, l) samples. */
function fitQuadratic(samples: ReadonlyArray<[number, number, number]>): ((x: number, y: number) => number) | null {
  if (samples.length < 6) return null;
  const terms = (x: number, y: number) => [1, x, y, x * x, x * y, y * y];
  const n = 6;
  const a = Array.from({ length: n }, () => new Array<number>(n + 1).fill(0));
  for (const [x, y, l] of samples) {
    const t = terms(x, y);
    for (let i = 0; i < n; i += 1) {
      for (let j = 0; j < n; j += 1) a[i]![j]! += t[i]! * t[j]!;
      a[i]![n]! += t[i]! * l;
    }
  }
  // Gaussian elimination with partial pivoting.
  for (let col = 0; col < n; col += 1) {
    let pivot = col;
    for (let row = col + 1; row < n; row += 1) if (Math.abs(a[row]![col]!) > Math.abs(a[pivot]![col]!)) pivot = row;
    if (Math.abs(a[pivot]![col]!) < 1e-9) return null;
    [a[col], a[pivot]] = [a[pivot]!, a[col]!];
    for (let row = 0; row < n; row += 1) {
      if (row === col) continue;
      const factor = a[row]![col]! / a[col]![col]!;
      for (let k = col; k <= n; k += 1) a[row]![k]! -= factor * a[col]![k]!;
    }
  }
  const coefficients = a.map((row, i) => row[n]! / row[i]!);
  return (x, y) => terms(x, y).reduce((sum, term, i) => sum + term * coefficients[i]!, 0);
}
