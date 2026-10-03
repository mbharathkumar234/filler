/**
 * Round seals, read (Stage 4).
 *
 * A certificate's issuing authority is often printed nowhere but in its seal:
 * the central EWS and OBC formats end "Signature with seal of Office", and the
 * officer's designation — TAHSILDAR, SAMPLEPURA TALUK — runs round a rubber
 * stamp, over the top of the ring and under the bottom. Read as the page is,
 * the top arc came back whole and the bottom one as "SAMMPLEPURAT".
 *
 * PaddleOCR reads a seal with a detector for curved text (PP-OCRv4 seal
 * detection), which is not published as ONNX — so it cannot run here. What it
 * does with what it finds, straightening a curved line before reading it, is
 * done here for the one shape a seal has: the ring is unrolled into two straight
 * strips, and the strips are read by the same models as the page.
 *
 *  - `findSeals` — a ring of coloured ink: a thin line of one colour, paper on
 *    either side, round enough that three points on it agree where its middle is.
 *  - `unrollSeal` — the ring as a strip: "over" runs clockwise from the bottom
 *    with the outer edge up, so text along the top is the strip's middle, the
 *    right way up; "under" runs anticlockwise from the top with the inner edge
 *    up, for text along the bottom. Only the seal's own ink is kept: print
 *    stamped over, which is black, becomes paper.
 *  - `sealWords` — what a strip says about its own arc.
 *  - `outsideSeals` — the page's reading less what lay along a ring, which the
 *    strips have read better.
 *
 * A seal in black ink — a photocopy — is not found: print and seal are one
 * colour, and no ring can be told from the text around it by colour alone.
 */

import type { Box, RgbaImage } from './paddle';
import { resizeBilinear } from './paddle';
import type { PlacedText } from './table';

/** A round seal: its middle, the radius of its outer ring, and the hue of its ink in degrees. */
export interface Seal {
  cx: number;
  cy: number;
  r: number;
  /** Null: keep every colour when unrolling it. */
  hue: number | null;
}

// ---- ink --------------------------------------------------------------------

/** Ink is coloured: this saturated … */
const INK_SATURATION = 0.35;
/** … and this bright, so black print is not ink however its scanner tinted it. */
const INK_VALUE = 0.24;

function hsv(r: number, g: number, b: number): { h: number; s: number; v: number } {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d > 0) {
    if (max === r) h = 60 * (((g - b) / d) % 6);
    else if (max === g) h = 60 * ((b - r) / d + 2);
    else h = 60 * ((r - g) / d + 4);
  }
  return { h: (h + 360) % 360, s: max === 0 ? 0 : d / max, v: max / 255 };
}

/** 1 where a pixel is coloured ink, 0 where it is paper, print or grey. */
export function inkMask(image: RgbaImage): Uint8Array {
  const mask = new Uint8Array(image.width * image.height);
  for (let i = 0; i < mask.length; i += 1) {
    const { s, v } = hsv(image.data[i * 4]!, image.data[i * 4 + 1]!, image.data[i * 4 + 2]!);
    if (s > INK_SATURATION && v > INK_VALUE) mask[i] = 1;
  }
  return mask;
}

// ---- 1. finding a seal ------------------------------------------------------

/** Seals are looked for on a copy of the page this size, then placed back. */
const FIND_SIDE = 1000;
/** A seal's radius, as a share of the page's long side. */
const MIN_RADIUS_SHARE = 0.025;
const MAX_RADIUS_SHARE = 0.2;
const MIN_RADIUS_PX = 12;
/** Of the ring's way round, how much must be ink. */
const RING_COVERED = 0.7;
/** Just outside the ring, at most this much: a ring has paper beyond it. */
const OUTSIDE_COVERED = 0.5;
/** And the ring stands out from either side by this much: a photo is ink everywhere. */
const RING_STANDS_OUT = 0.3;
const MAX_SEALS = 3;
const TRIES = 1500;
const ANGLES = 180;

/** A small, seeded generator: the same page finds the same seals every time. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** How much of the way round a circle is ink, within a pixel or two of its line. */
function covered(mask: Uint8Array, width: number, height: number, cx: number, cy: number, r: number): number {
  const slack = Math.max(1.5, r * 0.025);
  let hits = 0;
  for (let i = 0; i < ANGLES; i += 1) {
    const a = (i / ANGLES) * 2 * Math.PI;
    const cos = Math.cos(a);
    const sin = Math.sin(a);
    for (const rr of [r - slack, r, r + slack]) {
      const x = Math.round(cx + rr * cos);
      const y = Math.round(cy + rr * sin);
      if (x >= 0 && y >= 0 && x < width && y < height && mask[y * width + x] === 1) {
        hits += 1;
        break;
      }
    }
  }
  return hits / ANGLES;
}

/** The circle through three points, or null when they lie on a line. */
function through(
  [ax, ay]: readonly [number, number],
  [bx, by]: readonly [number, number],
  [cx, cy]: readonly [number, number],
): { cx: number; cy: number; r: number } | null {
  const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
  if (Math.abs(d) < 1e-6) return null;
  const a2 = ax * ax + ay * ay;
  const b2 = bx * bx + by * by;
  const c2 = cx * cx + cy * cy;
  const x = (a2 * (by - cy) + b2 * (cy - ay) + c2 * (ay - by)) / d;
  const y = (a2 * (cx - bx) + b2 * (ax - cx) + c2 * (bx - ax)) / d;
  return { cx: x, cy: y, r: Math.hypot(ax - x, ay - y) };
}

/**
 * Whether a circle is a ring of ink: covered along its line, with paper just
 * beyond it, and standing out from both sides. A seal's lettering lies inside
 * its ring and covers part of the way round; a photo covers all of it.
 */
function ringScore(mask: Uint8Array, width: number, height: number, c: { cx: number; cy: number; r: number }): number {
  const on = covered(mask, width, height, c.cx, c.cy, c.r);
  if (on < RING_COVERED) return 0;
  const step = Math.max(4, c.r * 0.12);
  const outside = covered(mask, width, height, c.cx, c.cy, c.r + step);
  const inside = covered(mask, width, height, c.cx, c.cy, c.r - step);
  if (outside > OUTSIDE_COVERED || on - Math.max(inside, outside) < RING_STANDS_OUT) return 0;
  return on;
}

/** The circle nudged a pixel at a time while that makes it more of a ring. */
function refine(mask: Uint8Array, width: number, height: number, start: { cx: number; cy: number; r: number }) {
  let best = start;
  let score = ringScore(mask, width, height, best);
  for (const step of [2, 1, 0.5]) {
    let moved = true;
    while (moved) {
      moved = false;
      for (const [dx, dy, dr] of [
        [step, 0, 0],
        [-step, 0, 0],
        [0, step, 0],
        [0, -step, 0],
        [0, 0, step],
        [0, 0, -step],
      ] as const) {
        const next = { cx: best.cx + dx, cy: best.cy + dy, r: best.r + dr };
        const nextScore = ringScore(mask, width, height, next);
        if (nextScore > score) {
          best = next;
          score = nextScore;
          moved = true;
        }
      }
    }
  }
  return { ...best, score };
}

/** The hue of the ring's own ink: the mean, round the colour wheel, of its pixels. */
function ringHue(image: RgbaImage, mask: Uint8Array, c: { cx: number; cy: number; r: number }): number | null {
  let x = 0;
  let y = 0;
  for (let i = 0; i < ANGLES; i += 1) {
    const a = (i / ANGLES) * 2 * Math.PI;
    const px = Math.round(c.cx + c.r * Math.cos(a));
    const py = Math.round(c.cy + c.r * Math.sin(a));
    if (px < 0 || py < 0 || px >= image.width || py >= image.height || mask[py * image.width + px] !== 1) continue;
    const at = (py * image.width + px) * 4;
    const { h } = hsv(image.data[at]!, image.data[at + 1]!, image.data[at + 2]!);
    x += Math.cos((h * Math.PI) / 180);
    y += Math.sin((h * Math.PI) / 180);
  }
  if (x === 0 && y === 0) return null;
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/**
 * The round seals on a page, largest ring first within each seal.
 *
 * Three points of ink at a time, each three agreeing on a circle; the circle
 * that is most a ring wins (`ringScore`), and is nudged until it fits. A seal
 * with an inner ring is two rings round one middle: the outer one is the seal,
 * so a larger ring round the same middle is looked for before it is taken. Its
 * ink is then set aside, and the page looked at again for another.
 */
export function findSeals(image: RgbaImage): Seal[] {
  const scale = Math.min(1, FIND_SIDE / Math.max(image.width, image.height));
  const small =
    scale < 1
      ? resizeBilinear(image, Math.max(1, Math.round(image.width * scale)), Math.max(1, Math.round(image.height * scale)))
      : image;
  const { width, height } = small;
  const mask = inkMask(small);
  const long = Math.max(width, height);
  const minR = Math.max(MIN_RADIUS_PX, MIN_RADIUS_SHARE * long);
  const maxR = MAX_RADIUS_SHARE * long;
  const next = random(0x5ea1);

  const seals: Seal[] = [];
  for (let found = 0; found < MAX_SEALS; found += 1) {
    const points: Array<[number, number]> = [];
    for (let i = 0; i < mask.length; i += 1) if (mask[i] === 1) points.push([i % width, Math.floor(i / width)]);
    if (points.length < 30) break;

    let best: { cx: number; cy: number; r: number; score: number } | null = null;
    for (let t = 0; t < TRIES; t += 1) {
      const circle = through(
        points[Math.floor(next() * points.length)]!,
        points[Math.floor(next() * points.length)]!,
        points[Math.floor(next() * points.length)]!,
      );
      if (circle === null || circle.r < minR || circle.r > maxR) continue;
      const score = ringScore(mask, width, height, circle);
      if (score > (best?.score ?? 0)) best = { ...circle, score };
    }
    if (best === null) break;
    let ring = refine(mask, width, height, best);

    // The outer ring of the same seal, if there is one.
    for (let r = ring.r * 1.08; r <= Math.min(maxR, ring.r * 1.8); r += 1) {
      const outer = { cx: ring.cx, cy: ring.cy, r };
      if (ringScore(mask, width, height, outer) > 0) {
        ring = refine(mask, width, height, outer);
        break;
      }
    }

    seals.push({ cx: ring.cx / scale, cy: ring.cy / scale, r: ring.r / scale, hue: ringHue(small, mask, ring) });

    // This seal's ink set aside, so the next look finds another.
    const clear = ring.r + Math.max(6, ring.r * 0.1);
    for (let y = Math.max(0, Math.floor(ring.cy - clear)); y <= Math.min(height - 1, ring.cy + clear); y += 1) {
      for (let x = Math.max(0, Math.floor(ring.cx - clear)); x <= Math.min(width - 1, ring.cx + clear); x += 1) {
        if (Math.hypot(x - ring.cx, y - ring.cy) <= clear) mask[y * width + x] = 0;
      }
    }
  }
  return seals;
}

// ---- 2. unrolling it --------------------------------------------------------

/** The band of the ring that is unrolled, as shares of its radius: inside the outer ring, to past the lettering. */
const BAND_INNER = 0.55;
const BAND_OUTER = 1.0;
/** The strip's height at least, in pixels: the reader reads lettering this size well. */
export const STRIP_BAND = 96;
const MAX_STRIP_SCALE = 4;
/** How far from the seal's ink a colour may be and still be kept, in degrees round the wheel. */
const HUE_KEPT = 24;
const KEPT_SATURATION = 0.24;

function sample(image: RgbaImage, x: number, y: number): [number, number, number] {
  if (x < 0 || y < 0 || x > image.width - 1 || y > image.height - 1) return [255, 255, 255];
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(x0 + 1, image.width - 1);
  const y1 = Math.min(y0 + 1, image.height - 1);
  const wx = x - x0;
  const wy = y - y0;
  const out: [number, number, number] = [0, 0, 0];
  for (let c = 0; c < 3; c += 1) {
    const top = image.data[(y0 * image.width + x0) * 4 + c]! * (1 - wx) + image.data[(y0 * image.width + x1) * 4 + c]! * wx;
    const bottom = image.data[(y1 * image.width + x0) * 4 + c]! * (1 - wx) + image.data[(y1 * image.width + x1) * 4 + c]! * wx;
    out[c] = top * (1 - wy) + bottom * wy;
  }
  return out;
}

/**
 * The ring as a straight strip, its lettering the right way up in the middle.
 *
 * "over": clockwise from the bottom, the outer edge up — the top arc's text.
 * "under": anticlockwise from the top, the inner edge up — the bottom arc's,
 * which a seal prints to be read from below. Lettering the other way round on
 * either arc comes out upside down, which the reader's line classifier turns.
 * Drawn large enough to read, and with only the seal's own ink kept.
 */
export function unrollSeal(image: RgbaImage, seal: Seal, way: 'over' | 'under'): RgbaImage {
  const inner = seal.r * BAND_INNER;
  const outer = seal.r * BAND_OUTER;
  const scale = Math.min(MAX_STRIP_SCALE, Math.max(1, STRIP_BAND / (outer - inner)));
  const height = Math.max(1, Math.round((outer - inner) * scale));
  const width = Math.max(1, Math.round(Math.PI * (inner + outer) * scale));
  const data = new Uint8ClampedArray(width * height * 4);

  for (let y = 0; y < height; y += 1) {
    const r = way === 'over' ? outer - y / scale : inner + y / scale;
    for (let x = 0; x < width; x += 1) {
      const turn = (2 * Math.PI * x) / width;
      const a = way === 'over' ? Math.PI / 2 + turn : (3 * Math.PI) / 2 - turn;
      let [red, green, blue] = sample(image, seal.cx + r * Math.cos(a), seal.cy + r * Math.sin(a));
      if (seal.hue !== null) {
        const { h, s } = hsv(red, green, blue);
        const apart = Math.min(Math.abs(h - seal.hue), 360 - Math.abs(h - seal.hue));
        if (apart > HUE_KEPT || s < KEPT_SATURATION) [red, green, blue] = [255, 255, 255];
      }
      const at = (y * width + x) * 4;
      data[at] = red;
      data[at + 1] = green;
      data[at + 2] = blue;
      data[at + 3] = 255;
    }
  }
  return { data, width, height };
}

// ---- 3. what a strip says -----------------------------------------------------

/** A reading in a strip counted as the seal's: this sure … */
const SEAL_SURE = 0.8;

/**
 * The words a strip read along its own arc: those in its middle half — the
 * ends are the other arc, read by the other strip — sure ones, of two letters
 * or more, left to right.
 */
export function sealWords(items: ReadonlyArray<PlacedText & { score: number }>, stripWidth: number): string {
  return items
    .filter((item) => {
      const middle = (item.box.x0 + item.box.x1) / 2;
      return (
        middle >= stripWidth / 4 &&
        middle <= (3 * stripWidth) / 4 &&
        item.score >= SEAL_SURE &&
        (item.text.match(/\p{L}/gu) ?? []).length >= 2
      );
    })
    .sort((a, b) => a.box.x0 - b.box.x0)
    .map((item) => item.text.trim())
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Where a seal sits on the page. */
export function sealBox(seal: Seal): Box {
  return { x0: seal.cx - seal.r, y0: seal.cy - seal.r, x1: seal.cx + seal.r, y1: seal.cy + seal.r };
}

/**
 * The page's own reading, less what lay along a seal's ring.
 *
 * A piece of text whose middle is on the ring's lettering, and which lies
 * within the seal, was a guess at curved letters — the strips have read them
 * straight. The seal's middle is kept (it is printed straight), and so is a
 * line that only runs across the seal.
 */
export function outsideSeals<T extends PlacedText>(items: readonly T[], seals: readonly Seal[]): T[] {
  return items.filter(
    (item) =>
      !seals.some((seal) => {
        const middle = Math.hypot((item.box.x0 + item.box.x1) / 2 - seal.cx, (item.box.y0 + item.box.y1) / 2 - seal.cy);
        const reach = seal.r * 1.3;
        return (
          middle >= seal.r * 0.5 &&
          middle <= seal.r * 1.1 &&
          item.box.x0 >= seal.cx - reach &&
          item.box.x1 <= seal.cx + reach &&
          item.box.y0 >= seal.cy - reach &&
          item.box.y1 <= seal.cy + reach
        );
      }),
  );
}
