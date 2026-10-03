import { describe, expect, it } from 'vitest';

import type { RgbaImage } from './paddle';
import { findSeals, inkMask, outsideSeals, sealWords, unrollSeal, STRIP_BAND } from './seal';

const VIOLET = [76, 46, 158] as const;
const BLUE_PEN = [27, 42, 107] as const;
const BLACK = [20, 20, 20] as const;

function paper(width: number, height: number): RgbaImage {
  return { data: new Uint8ClampedArray(width * height * 4).fill(255), width, height };
}

function dot(image: RgbaImage, x: number, y: number, [r, g, b]: readonly [number, number, number]) {
  const px = Math.round(x);
  const py = Math.round(y);
  if (px < 0 || py < 0 || px >= image.width || py >= image.height) return;
  const at = (py * image.width + px) * 4;
  image.data[at] = r;
  image.data[at + 1] = g;
  image.data[at + 2] = b;
}

/** A ring of ink, `width` pixels thick. */
function ring(image: RgbaImage, cx: number, cy: number, radius: number, width: number, ink: readonly [number, number, number]) {
  for (let y = Math.floor(cy - radius - width); y <= cy + radius + width; y += 1) {
    for (let x = Math.floor(cx - radius - width); x <= cx + radius + width; x += 1) {
      const d = Math.hypot(x - cx, y - cy);
      if (Math.abs(d - radius) <= width / 2) dot(image, x, y, ink);
    }
  }
}

function block(image: RgbaImage, x0: number, y0: number, x1: number, y1: number, ink: readonly [number, number, number]) {
  for (let y = y0; y <= y1; y += 1) for (let x = x0; x <= x1; x += 1) dot(image, x, y, ink);
}

/** A page with a round seal on it: two rings, marks for letters between them, print across it. */
function sealedPage() {
  const page = paper(900, 600);
  // Lines of black print, one of them running across the seal.
  for (let y = 60; y < 300; y += 40) block(page, 40, y, 820, y + 14, BLACK);
  block(page, 520, 470, 860, 484, BLACK);
  ring(page, 650, 450, 110, 4, VIOLET);
  ring(page, 650, 450, 72, 2, VIOLET);
  // "Letters" in the band, over the top and under the bottom.
  for (let a = 200; a <= 340; a += 12) {
    const t = (a * Math.PI) / 180;
    block(page, 650 + 92 * Math.cos(t) - 4, 450 + 92 * Math.sin(t) - 7, 650 + 92 * Math.cos(t) + 4, 450 + 92 * Math.sin(t) + 7, VIOLET);
  }
  // A signature in a blue pen, crossing the ring.
  for (let x = 560; x < 700; x += 1) dot(page, x, 500 + 12 * Math.sin(x / 9), BLUE_PEN);
  return page;
}

describe('finding a seal', () => {
  it('finds a round seal by its ring of coloured ink, and its outer ring rather than its inner', () => {
    const [seal, ...more] = findSeals(sealedPage());
    expect(more).toEqual([]);
    expect(seal!.cx).toBeCloseTo(650, -1);
    expect(seal!.cy).toBeCloseTo(450, -1);
    expect(Math.abs(seal!.r - 110)).toBeLessThan(4);
    // Violet: the ring's own hue, which the strip keeps and nothing else.
    expect(seal!.hue).toBeGreaterThan(240);
    expect(seal!.hue).toBeLessThan(270);
  });

  it('finds two seals on a page that has two', () => {
    const page = sealedPage();
    ring(page, 180, 450, 90, 4, [180, 30, 40]);
    const seals = findSeals(page).sort((a, b) => a.cx - b.cx);
    expect(seals.map((seal) => Math.round(seal.cx / 10) * 10)).toEqual([180, 650]);
  });

  it('finds none on a page of print, a coloured heading and an underline', () => {
    const page = paper(900, 600);
    for (let y = 60; y < 500; y += 40) block(page, 40, y, 820, y + 14, BLACK);
    block(page, 300, 20, 600, 44, VIOLET);
    block(page, 40, 540, 820, 543, VIOLET);
    expect(findSeals(page)).toEqual([]);
  });

  it('finds none in a photo printed on a card: a ring of ink is a line, with paper either side of it', () => {
    const page = paper(900, 600);
    block(page, 600, 300, 820, 560, [190, 140, 110]);
    block(page, 640, 340, 780, 520, [60, 90, 160]);
    expect(findSeals(page)).toEqual([]);
  });

  it('finds no seal in black ink: print and a seal are one colour, and cannot be told apart', () => {
    const page = paper(900, 600);
    ring(page, 650, 450, 110, 4, BLACK);
    expect(findSeals(page)).toEqual([]);
  });

  it('takes ink to be coloured, not black, grey or paper', () => {
    const page = paper(4, 1);
    dot(page, 0, 0, VIOLET);
    dot(page, 1, 0, BLACK);
    dot(page, 2, 0, [150, 150, 150]);
    expect([...inkMask(page)]).toEqual([1, 0, 0, 0]);
  });
});

describe('unrolling a seal into strips', () => {
  const seal = { cx: 200, cy: 200, r: 100, hue: 256 };

  it('lays the top of the ring along the middle of the "over" strip, outward up', () => {
    const page = paper(400, 400);
    // A mark just inside the outer edge, at the top.
    block(page, 196, 108, 204, 116, VIOLET);
    const strip = unrollSeal(page, seal, 'over');
    expect(strip.height).toBeGreaterThanOrEqual(STRIP_BAND);
    const dark = darkColumns(strip);
    expect(dark.length).toBeGreaterThan(0);
    const middle = (dark[0]! + dark[dark.length - 1]!) / 2;
    expect(middle / strip.width).toBeCloseTo(0.5, 1);
    // Near the top of the strip: the outer edge is up.
    expect(darkRows(strip)[0]! / strip.height).toBeLessThan(0.4);
  });

  it('lays the bottom of the ring along the middle of the "under" strip, inward up', () => {
    const page = paper(400, 400);
    block(page, 196, 284, 204, 292, VIOLET);
    const strip = unrollSeal(page, seal, 'under');
    const dark = darkColumns(strip);
    expect(((dark[0]! + dark[dark.length - 1]!) / 2) / strip.width).toBeCloseTo(0.5, 1);
    expect(darkRows(strip)[0]! / strip.height).toBeGreaterThan(0.6);
  });

  it('keeps only the seal’s own ink: print across it, and a pen of another colour, are paper in the strip', () => {
    const page = paper(400, 400);
    block(page, 120, 108, 280, 116, BLACK);
    expect(darkColumns(unrollSeal(page, seal, 'over'))).toEqual([]);
    const signed = paper(400, 400);
    block(signed, 120, 108, 280, 116, [190, 90, 20]);
    expect(darkColumns(unrollSeal(signed, seal, 'over'))).toEqual([]);
    // Print a scanner tinted violet: the seal's hue, but hardly coloured at all.
    const tinted = paper(400, 400);
    block(tinted, 120, 108, 280, 116, [40, 38, 48]);
    expect(darkColumns(unrollSeal(tinted, seal, 'over'))).toEqual([]);
    // With no ink to keep to, everything is kept.
    expect(darkColumns(unrollSeal(page, { ...seal, hue: null }, 'over')).length).toBeGreaterThan(0);
  });
});

function darkAt(image: RgbaImage, x: number, y: number): boolean {
  const at = (y * image.width + x) * 4;
  return image.data[at]! + image.data[at + 1]! + image.data[at + 2]! < 600;
}
function darkColumns(image: RgbaImage): number[] {
  const out: number[] = [];
  for (let x = 0; x < image.width; x += 1) {
    for (let y = 0; y < image.height; y += 1) {
      if (darkAt(image, x, y)) {
        out.push(x);
        break;
      }
    }
  }
  return out;
}
function darkRows(image: RgbaImage): number[] {
  const out: number[] = [];
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      if (darkAt(image, x, y)) {
        out.push(y);
        break;
      }
    }
  }
  return out;
}

describe('what the strips say', () => {
  const at = (text: string, x0: number, x1: number, score = 0.99) => ({ text, score, box: { x0, y0: 10, x1, y1: 40 } });

  it('takes the words in the strip’s middle half — its own arc — sure ones only, left to right', () => {
    // The ends of the strip are the other arc, upside down: the other strip reads those.
    const items = [
      at('SAMPLE', 0, 70),
      at('TAHSILDAR', 200, 340),
      at('d', 163, 178, 0.15),
      at('*', 412, 425, 0.87),
      at('PURA TAJK', 471, 584, 0.9),
    ];
    expect(sealWords(items, 584)).toBe('TAHSILDAR');
  });

  it('joins the words of an arc read in pieces, in order', () => {
    expect(sealWords([at('TALUK', 330, 410), at('SAMPLEPURA', 160, 320)], 584)).toBe('SAMPLEPURA TALUK');
  });
});

describe('the page’s own reading of a seal', () => {
  const seal = { cx: 960, cy: 550, r: 120, hue: 256 };
  const at = (text: string, x0: number, y0: number, x1: number, y1: number) => ({
    text,
    score: 0.9,
    box: { x0, y0, x1, y1 },
  });

  it('is set aside where the ring is — the seal’s own reading replaces it — and kept elsewhere', () => {
    const items = [
      at('TAHSILDAR', 839, 402, 1036, 511),
      at('SAMMPLEPURAT', 874, 613, 1032, 680),
      // The seal's middle: straight print, read as the page is.
      at('KARNATAKA', 911, 536, 1017, 580),
      // A signature over the middle.
      at('Samplegowda', 891, 566, 1052, 600),
      // A line running across the seal, most of it outside.
      at('Signature of the issuing authority', 640, 600, 1180, 627),
      at('Date of Issue : 14/03/2024', 54, 288, 309, 316),
    ];
    expect(outsideSeals(items, [seal]).map((item) => item.text)).toEqual([
      'KARNATAKA',
      'Samplegowda',
      'Signature of the issuing authority',
      'Date of Issue : 14/03/2024',
    ]);
  });
});
